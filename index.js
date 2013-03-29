'use strict'

require('inherits')(PkzipParser, require('simple-reader'))
require('mkstream')(PkzipDataStream)

var Buffer = require('buffer').Buffer

module.exports = PkzipParser

var S             = 0
, READY             = ++S //ready to read the next 4 bytes for header signature
, FILE_HEAD         = ++S //ready to read a file header -- 22 bytes
, FILE_HEADER_EXTRA = ++S //extra data + file name fields
, FILE_DATA         = ++S
, DATA_DESCRIPTOR   = ++S
, CENTRAL_DIRECTORY = ++S
, CD_EXTRA          = ++S
, CD_END            = ++S
, CD_END_EXTRA      = ++S
, SKIP              = ++S //generic skip-everything status

, FILE_HEADER_SIGNATURE       = 0x04034B50
, DATA_DESCRIPTOR_SIGNATURE   = 0x08074B50
, CENTRAL_DIRECTORY_SIGNATURE = 0x02014B50
, CD_END_SIGNATURE            = 0x06054B50

, COMPRESSION_UNCOMPRESSED      = 0x0
, COMPRESSION_SHRINK            = 0x1
, COMPRESSION_REDUCE_1          = 0x2
, COMPRESSION_REDUCE_2          = 0x3
, COMPRESSION_REDUCE_3          = 0x4
, COMPRESSION_REDUCE_4          = 0x5
, COMPRESSION_IMPLODE           = 0x6
, COMPRESSION_DEFLATE           = 0x8
, COMPRESSION_DEFLATE_ENHANCED  = 0x9
, COMPRESSION_BZIP2             = 0xC
, COMPRESSION_LZMA              = 0xD

, COMPRESSION_TYPES = {}
, C = COMPRESSION_TYPES

C[COMPRESSION_UNCOMPRESSED] = "uncompressed"
C[COMPRESSION_SHRINK] = "shrink"
C[COMPRESSION_REDUCE_1] = "reduce-1"
C[COMPRESSION_REDUCE_2] = "reduce-2"
C[COMPRESSION_REDUCE_3] = "reduce-3"
C[COMPRESSION_REDUCE_4] = "reduce-4"
C[COMPRESSION_IMPLODE] = "implode"
C[COMPRESSION_DEFLATE] = "deflate"
C[COMPRESSION_DEFLATE_ENHANCED] = "deflate-enhanced"
C[COMPRESSION_BZIP2] = "bzip2"
C[COMPRESSION_LZMA] = "lzma"

function PkzipParser(readExtra){
  this.initReader()
  this.offset = 0
  this.status = {}
  this.statusId = READY
  this.readExtra = readExtra // by default, only read what's necessary to stream data
}

PkzipParser.prototype.end = function(data){
  if(data)
    this.cache.push(data)
  this._reader.ended = true
  this.readNext()
}

PkzipParser.prototype.readNext = function(){
  loop:while(true){
    switch(this.statusId){
      case READY:
        var signatureHeader = this.read(4, true)

        if(signatureHeader){
          this.offset += 4
          var signature = signatureHeader.readUInt32LE(0, true)
          if(signature == FILE_HEADER_SIGNATURE){
            this.statusId = FILE_HEAD
            continue loop
          } else if(signature == CENTRAL_DIRECTORY_SIGNATURE){
            if(!this.readExtra) // all file headers are finished
              return this.statusId = SKIP,this.emit('end')
            this.statusId = CENTRAL_DIRECTORY
            continue loop
          } else if(signature == CD_END_SIGNATURE){
            if(!this.readExtra) // all file headers are finished
              return this.statusId = SKIP, this.emit('end')
            this.statusId = CD_END
            continue loop
          } else {
            this.emit('error', new Error('Unknown signature encountered: '  + signature.toString(16)))
            this.statusId = SKIP
          }
        } else if(this.ended){
          this.emit('end')
          break loop
        } else {
          break loop
        }
        break
      case FILE_HEAD:
        var headerData = this.read(26)

        if(headerData){
          this.offset += 26
          var header = {
            version: headerData.readUInt16LE(0, true)
            , bitFlags: headerData.readUInt16LE(2,true)
            , compressionTypeId: headerData.readUInt16LE(4,true)
            , lastModTimeRaw: headerData.readUInt16LE(6, true)
            , lastModDateRaw: headerData.readUInt16LE(8, true)
            , crc32: headerData.readUInt32LE(10, true)
            , compressedSize: headerData.readUInt32LE(14, true)
            , uncompressedSize: headerData.readUInt32LE(18, true)
            , fileNameLength: headerData.readUInt16LE(22, true)
            , extraFieldLength: headerData.readUInt16LE(24, true)
          }

          header.dataDescriptor = !!(header.bitFlags & 0x8)
          header.compressionType = COMPRESSION_TYPES[header.compressionTypeId] || 'unknown'

          //positional data
          var headerSize = 30 + header.fileNameLength + header.extraFieldLength 
          var position = {
            headerSize: headerSize
            , length: header.compressedSize + headerSize
            , offset: this.offset - 30
          }
          //parse date / time fields
          if(this.readExtra){
            header.lastModTime = parseDOSTime(header.lastModTimeRaw)
            header.lastModDate = parseDOSDate(header.lastModDateRaw)
          }
          this.status = {header:header, position: position} 
          this.statusId = FILE_HEADER_EXTRA
          continue loop
        } else {
          break loop
        }
        break
      case FILE_HEADER_EXTRA:
        var header = this.status.header
        var extraDataLength = header.fileNameLength + header.extraFieldLength
        if(!extraDataLength)
          return this.statusId = FILE_DATA
        var extraData = this.read(extraDataLength)

        if(extraData){
          this.offset += extraDataLength
          var fileNameData = extraData.slice(0, header.fileNameLength)
          header.fileName = fileNameData.toString() 
          if(this.readExtra){
            header.extraFieldData = extraData.slice(header.fileNameLength)
          }
          this.statusId = FILE_DATA
          this.status.position.read = 0
          this.status.stream = new PkzipDataStream()
          this.emit('file', this.status.header, this.status.position, this.status.stream)
          continue loop
        } else {
          break loop
        }
        break
      case FILE_DATA:
        var reader = this._reader
        var currentBuffer = reader.cache[reader.cacheCursor]
        if(currentBuffer){
          if(!this.status.header.dataDescriptor){
            var total = this.status.header.compressedSize
            var remaining = total - this.status.position.read
            var bufferRemain = currentBuffer.length - reader.cursor
            if(remaining > bufferRemain){
              var dataSlice = currentBuffer.slice(reader.cursor)
              reader.cacheCursor += 1
              reader.cursor = 0
              this.offset += bufferRemain
              this.status.position.read += bufferRemain
              this.status.stream.emit('data', dataSlice)
              continue loop
            } else {
              if(remaining > 0){
                var dataSlice = currentBuffer.slice(reader.cursor, reader.cursor + remaining)
                this.offset += remaining
                reader.cursor += remaining
                this.status.position.read += remaining
                this.status.stream.emit('data', dataSlice)
              }
              this.status.stream.emit('end')
              this.statusId = this.status.header.dataDescriptor ? DATA_DESCRIPTOR :  READY
              continue loop
            }
          } else {
            // have to manually seek the Data Descriptor signature. Not fun. Might add later
            this.emit('error', new Error('Data Descriptors not implemented'))
            this.statusId = SKIP
          }
        } else {
          break loop
        }
        break
      case DATA_DESCRIPTOR:
        break
      case CENTRAL_DIRECTORY:
        var headerData = this.read(42)

        if(headerData){
          this.offset += 42
          var header = {
            version: headerData.readUInt16LE(0, true)
            , minVersion: headerData.readUInt16LE(2, true)
            , bitFlags: headerData.readUInt16LE(4,true)
            , compressionType: headerData.readUInt16LE(6,true)
            , lastModTimeRaw: headerData.readUInt16LE(8, true)
            , lastModDateRaw: headerData.readUInt16LE(10, true)
            , crc32: headerData.readUInt32LE(12, true)
            , compressedSize: headerData.readUInt32LE(16, true)
            , uncompressedSize: headerData.readUInt32LE(20, true)
            , fileNameLength: headerData.readUInt16LE(24, true)
            , extraFieldLength: headerData.readUInt16LE(26, true)
            , fileCommentLength: headerData.readUInt16LE(28, true)
            , diskNumber: headerData.readUInt16LE(30, true)
            , internalAttributes: headerData.readUInt16LE(32, true)
            , externalAttributes: headerData.readUInt32LE(34, true)
            , offset: headerData.readUInt32LE(38, true)
          }
          header.dataDescriptor = !!(header.bitFlags & 0x8)
          //parse data / time fields
          if(this.readExtra){
            header.lastModTime = parseDOSTime(header.lastModTimeRaw)
            header.lastModDate = parseDOSDate(header.lastModDateRaw)
          }
          this.status = {header:header}
          this.statusId = CD_EXTRA
          continue loop
        } else {
          break loop
        }
        break
      case CD_EXTRA:
        var header = this.status.header
        var extraDataLength = header.fileNameLength + header.extraFieldLength + header.fileCommentLength
        if(!extraDataLength)
          return this.statusId  = READY
        var extraData = this.read(extraDataLength)

        if(extraData){
          this.offset += extraDataLength
          var fileNameData = extraData.slice(0, header.fileNameLength)
          header.fileName = fileNameData.toString()
          header.extraFieldData = extraData.slice(header.fileNameLength, header.fileNameLength + header.extraFieldLength)
          var fileCommentData = extraData.slice(header.fileNameLength + header.extraFieldLength)
          header.fileComment = fileCommentData.toString()
          this.emit('cd', this.status)
          this.statusId = READY
          continue loop
        } else {
          break loop
        }

        break
      case CD_END:
        var headerData = this.read(18)

        if(headerData){
          this.offset += 18
          var header = {
            diskNumber: headerData.readUInt16LE(0, true)
            , diskCDStartNumber: headerData.readUInt16LE(2, true)
            , CDDiskCount: headerData.readUInt16LE(4, true)
            , CDTotalCount: headerData.readUInt16LE(6, true)
            , CDTotalSize: headerData.readUInt32LE(8, true)
            , CDOffset: headerData.readUInt32LE(12, true)
            , commentLength: headerData.readUInt16LE(16, true)
          }
          this.status = {header:header}
          this.statusId = READY
          continue loop
        } else {
          break loop
        }

        break
      case CD_END_EXTRA:
        var header = this.status.header
        if(!header.commentLength){
          var commentData = this.read(header.commentLength)
          if(!commentData)
            break loop
          this.offset += header.commentLength
          header.comment = commentData.toString()
        }
        this.statusId = READY
        this.emit('cd-end', this.status)
        this.emit('end')
        break
    }
  }
}

//not really using the parse all that much
function parseDOSTime(rawTime){
  var seconds = rawTime & 0x1f
  var minutes = (rawTime >> 5) & 0x3f
  var hour = rawTime >> 11
  return hour + ':' + minutes + ':' + seconds
}

function parseDOSDate(rawDate){
  var day = rawDate & 0x1f
  var month = (rawDate >> 5) & 0x0f
  var year = 1980 + (rawDate >> 9)
  return year + '-' + month + '-' + day
}

function PkzipDataStream(){
  this.readable = true
}
