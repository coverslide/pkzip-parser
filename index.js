'use strict'

require('mkstream')(PkzipParser)
require('mkstream')(PkzipDataStream)

var Buffer = require('buffer').Buffer

module.exports = PkzipParser

var S             = 0
, READY             = ++S //ready to read the next 4 bytes for header
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

function PkzipParser(readExtra){
  this.writable = true
  this.cache = []
  this.cursor = 0
  this.offset = 0
  this.cacheCursor = 0
  this.status = {}
  this.statusId = READY
  this.readExtra = readExtra // by default, only read what's necessary to stream data
}

PkzipParser.prototype.write = function(data){
  this.cache.push(data)
  this.nextStep()
}

PkzipParser.prototype.end = function(data){
  if(data)
    this.cache.push(data)
  this.ended = true
  this.nextStep()
}

PkzipParser.prototype.nextStep = function(){
  switch(this.statusId){
    case READY:
      var signatureHeader = this.read(4, true)

      if(signatureHeader){
        this.offset += 4
        var signature = signatureHeader.readUInt32LE(0, true)
        if(signature == FILE_HEADER_SIGNATURE){
          this.statusId = FILE_HEAD
          this.nextStep()
        } else if(signature == CENTRAL_DIRECTORY_SIGNATURE){
          if(!this.readExtra) // all file headers are finished
            return this.statusId = SKIP,this.emit('end')
          this.statusId = CENTRAL_DIRECTORY
          this.nextStep()
        } else if(signature == CD_END_SIGNATURE){
          if(!this.readExtra) // all file headers are finished
            return this.statusId = SKIP, this.emit('end')
          this.statusId = CD_END
          this.nextStep()
        } else {
          this.emit('error', new Error('Unknown signature encountered: '  + signature.toString(16)))
          this.statusId = SKIP
        }
      } else if(this.ended){
        this.emit('end')
      }
      break
    case FILE_HEAD:
      var headerData = this.read(26)

      if(headerData){
        this.offset += 26
        var header = {
          version: headerData.readUInt16LE(0, true)
          , bitFlags: headerData.readUInt16LE(2,true)
          , compressionType: headerData.readUInt16LE(4,true)
          , lastModTimeRaw: headerData.readUInt16LE(6, true)
          , lastModDateRaw: headerData.readUInt16LE(8, true)
          , crc32: headerData.readUInt32LE(10, true)
          , compressedSize: headerData.readUInt32LE(14, true)
          , uncompressedSize: headerData.readUInt32LE(18, true)
          , fileNameLength: headerData.readUInt16LE(22, true)
          , extraFieldLength: headerData.readUInt16LE(24, true)
        }

        var headerSize = 30 + header.fileNameLength + header.extraFieldLength 
        header.headerSize = headerSize
        header.length = header.compressedSize + headerSize
        header.offset = this.offset - 30
        header.dataDescriptor = !!(header.bitFlags & 0x8)
        //parse date / time fields
        if(this.readExtra){
          header.lastModTime = parseDOSTime(header.lastModTimeRaw)
          header.lastModDate = parseDOSDate(header.lastModDateRaw)
        }
        this.status = header
        this.statusId = FILE_HEADER_EXTRA
        this.nextStep()
      }
      break
    case FILE_HEADER_EXTRA:
      var header = this.status
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
        this.status.read = 0
        this.status.stream = new PkzipDataStream()
        this.emit('file', this.status)
        this.nextStep()
      }
      break
    case FILE_DATA:
      var currentBuffer = this.cache[this.cacheCursor]
      if(currentBuffer){
        if(!this.status.dataDescriptor){
          var total = this.status.compressedSize
          var remaining = total - this.status.read
          var bufferRemain = currentBuffer.length - this.cursor
          if(remaining > bufferRemain){
            var dataSlice = currentBuffer.slice(this.cursor)
            this.cacheCursor += 1
            this.cursor = 0
            this.offset += bufferRemain
            this.status.read += bufferRemain
            this.status.stream.emit('data', dataSlice)
            this.nextStep()
          } else {
            if(remaining > 0){
              var dataSlice = currentBuffer.slice(this.cursor, this.cursor + remaining)
              this.offset += remaining
              this.cursor += remaining
              this.status.read += remaining
              this.status.stream.emit('data', dataSlice)
            }
            this.status.stream.emit('end')
            this.statusId = this.status.dataDescriptor ? DATA_DESCRIPTOR :  READY
            this.nextStep()
          }
        } else {
          // have to manually seek the Data Descriptor signature. Not fun. Might add later
          this.emit('error', new Error('Data Descriptors not implemented'))
          this.statusId = SKIP
        }
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
        this.status = header
        this.statusId = CD_EXTRA
        this.nextStep()
      }
      break
    case CD_EXTRA:
      var header = this.status
      var extraDataLength = header.fileNameLength + header.extraFieldLength + header.fileCommentLength
      if(!extraDataLength)
        return this.statusId  = READY
      var extraData = this.read(extraDataLength)

      if(extraData){
        this.offset += extraDataLength
        var fileNameData = extraData.slice(0, header.fileNameLength)
        header.fileName = String.fromCharCode.apply(null, new UInt8Array(fileNameData))
        header.extraFieldData = extraData.slice(header.fileNameLength, header.fileNameLength + header.extraFieldLength)
        var fileCommentData = extraData.slice(header.fileNameLength + header.extraFieldLength)
        header.fileComment = String.fromCharCode.apply(null, new UInt8Array(fileCommentData))
        this.emit('cd', this.status)
        this.statusId = READY
        this.nextStep()
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
        this.status = header
        this.statusId = header.commentLength ? CD_END_EXTRA : READY 
        this.nextStep()
      }
      break
    case CD_END_EXTRA:
      if(!this.commentLength){
        var commentData = this.read(this.commentLength)
        if(!commentData)
          return
        this.offset += this.commentLength
        this.status.comment = String.fromCharCode.apply(null, new UInt8Array(commentData))
      }
      this.statusId = READY
      this.emit('cdEnd', this.status)
      this.emit('end')
      break
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

// TODO: good thing to separate into a module 
PkzipParser.prototype.read = function(count, endOk){
  var oldCursor = this.cursor
  var currentBuffer = this.cache[this.cacheCursor]
  if(currentBuffer){
    var readEnd = this.cursor + count
    if(readEnd <= currentBuffer.length){
      this.cursor += count
      var data = currentBuffer.slice(oldCursor, this.cursor)
      return data
    } else if(this.cache[this.cacheCursor + 1]) {
      var oldCacheCursor = this.cacheCursor
      var oldBuffer = currentBuffer.slice(this.cursor)

      this.cursor = 0
      this.cacheCursor += 1

      //let's hope this recurses safely
      var nextBuffer = this.read(count - oldBuffer.length, endOk)
      if(nextBuffer){
        var data = combineBuffers(oldBuffer, nextBuffer)
        return data
      } else {
        this.cursor = oldCursor
        this.cacheCursor = oldCacheCursor
      }
    }
  }
  if(this.ended && !endOk)
    this.emit('error', "read could not be performed on ended stream")
}

function combineBuffers(buf1, buf2){
  return Buffer.concat([buf1, buf2], buf1.length + buf2.length)
}

function PkzipDataStream(){
  this.readable = true
}
