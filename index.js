'use strict'

require('mkee')(PkzipParser)
require('mkstream')(PkzipDataStream)

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

function PkzipParser(stream, readExtra){
  this.cache = []
  this.cursor = 0
  this.cacheCursor = 0
  this.status = {}
  this.statusId = READY
  this.readExtra = readExtra // by default, only read what's necessary to stream data
  this.lp // length parameter
  
  var _this = this
  stream.on('data', function(data){
    if(!_this.lp){
      _this.lp = 'byteLength' in  data ? 'byteLength' : 'length'
    }
    _this.cache.push(data)
    _this.nextStep()
  })

  stream.on('end', function(){
    _this.ended = true
    _this.emit('end')
  })
}

PkzipParser.prototype.nextStep = function(){
  switch(this.statusId){
    case READY:
      var signatureHeader = this.read(4, false)

      if(signatureHeader){
        var dataView = new DataView(signatureHeader)
        var signature = dataView.getUint32(0, true)
        if(signature == FILE_HEADER_SIGNATURE){
          this.statusId = FILE_HEAD
          this.nextStep()
        } else if(signature == CENTRAL_DIRECTORY_SIGNATURE){
          if(!this.readExtra) // all file headers are finished
            return this.removeAllListeners('data')
          this.statusId = CENTRAL_DIRECTORY
          this.nextStep()
        } else if(signature == CD_END_SIGNATURE){
          if(!this.readExtra) // all file headers are finished
            return this.removeAllListeners('data')
          this.statusId = CD_END
          this.nextStep()
        } else {
          this.emit('error', new Error('Unknown signature encountered: '  + signature.toString(16)))
          this.statusId = SKIP
        }
      }
      break
    case FILE_HEAD:
      var headerData = this.read(26)

      if(headerData){
        var dataView = new DataView(headerData)
        var header = {
          version: dataView.getUint16(0, true)
          , bitFlags: dataView.getUint16(2,true)
          , compressionType: dataView.getUint16(4,true)
          , lastModTimeRaw: dataView.getUint16(6, true)
          , lastModDateRaw: dataView.getUint16(8, true)
          , crc32: dataView.getUint32(10, true)
          , compressedSize: dataView.getUint32(14, true)
          , uncompressedSize: dataView.getUint32(18, true)
          , fileNameLength: dataView.getUint16(22, true)
          , extraFieldLength: dataView.getUint16(24, true)
        }
        header.dataDescriptor = !!(header.bitFlags & 0x8)
        //parse data / time fields
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
        var fileNameData = extraData.slice(0, header.fileNameLength)
        header.fileName = String.fromCharCode.apply(null, new Uint8Array(fileNameData))
        if(this.readExtra){
          header.extraFieldData = extraData.slice(header.fileNameLength)
          if(header.extraFieldData[this.lp] > 0){
            header.extraField = parseExtraFieldData(header.extraFieldData)
          }
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
          var bufferRemain = currentBuffer[this.lp] - this.cursor
          if(remaining > bufferRemain){
            var dataSlice = currentBuffer.slice(this.cursor)
            this.cacheCursor += 1
            this.cursor = 0
            this.status.read += bufferRemain
            this.status.stream.emit('data', dataSlice)
            this.nextStep()
          } else {
            if(remaining > 0){
              var dataSlice = currentBuffer.slice(this.cursor, this.cursor + remaining)
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
        var dataView = new DataView(headerData)
        var header = {
          version: dataView.getUint16(0, true)
          , minVersion: dataView.getUint16(2, true)
          , bitFlags: dataView.getUint16(4,true)
          , compressionType: dataView.getUint16(6,true)
          , lastModTimeRaw: dataView.getUint16(8, true)
          , lastModDateRaw: dataView.getUint16(10, true)
          , crc32: dataView.getUint32(12, true)
          , compressedSize: dataView.getUint32(16, true)
          , uncompressedSize: dataView.getUint32(20, true)
          , fileNameLength: dataView.getUint16(24, true)
          , extraFieldLength: dataView.getUint16(26, true)
          , fileCommentLength: dataView.getUint16(28, true)
          , diskNumber: dataView.getUint16(30, true)
          , internalAttributes: dataView.getUint16(32, true)
          , externalAttributes: dataView.getUint32(34, true)
          , offset: dataView.getUint32(38, true)
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
        var fileNameData = extraData.slice(0, header.fileNameLength)
        header.fileName = String.fromCharCode.apply(null, new Uint8Array(fileNameData))
        header.extraFieldData = extraData.slice(header.fileNameLength, header.fileNameLength + header.extraFieldLength)
        var fileCommentData = extraData.slice(header.fileNameLength + header.extraFieldLength)
        header.fileComment = String.fromCharCode.apply(null, new Uint8Array(fileCommentData))
        if(header.extraFieldData[this.lp] > 0){
          //doesn't seem to work 100% in the CD
          //header.extraField = parseExtraFieldData(header.extraFieldData)
        }
        this.emit('cd', this.status)
        this.statusId = READY
        this.nextStep()
      }
      break
    case CD_END:
      var headerData = this.read(18)

      if(headerData){
        var dataView = new DataView(headerData)
        var header = {
          diskNumber: dataView.getUint16(0, true)
          , diskCDStartNumber: dataView.getUint16(2, true)
          , CDDiskCount: dataView.getUint16(4, true)
          , CDTotalCount: dataView.getUint16(6, true)
          , CDTotalSize: dataView.getUint32(8, true)
          , CDOffset: dataView.getUint32(12, true)
          , commentLength: dataView.getUint16(16, true)
        }
        this.status = header
        this.statusId = header.commentLength ? CD_END_EXTRA : READY 
        this.nextStep()
      }
      break
    case CD_END_EXTRA:
      if(!this.commentLength){
        var commentData = this.read(this.commentLength)
        this.status.comment = String.fromCharCode.apply(null, new Uint8Array(commentData))
      }
      this.statusId = READY
      this.emit('cdEnd', this.status)
      break
  }
}

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

function parseExtraFieldData(extraFieldData){
  var dataView = new DataView(extraFieldData)
  var offset = 0
  var length = dataView.byteLength
  var extraField = []
  while(offset < length){
    var id = dataView.getUint16(offset, true)
    var fieldLength = dataView.getUint16(offset + 2, true)
    offset += 4
    if(fieldLength > 0){
      var fieldData = extraFieldData.slice(offset, offset + fieldLength)
      offset += fieldLength
      var parsedFieldData = parseExtraField(id, fieldData)
    }
    extraField.push({id:id.toString(16), data: parsedFieldData || fieldData})
  }
  return extraField
}

//the ones that commonly seem to be generated on linux
var EF_EXTENDED_TIMESTAMP = 0x5455
var EF_EXTRA_FIELD_V3 = 0x7875

function parseExtraField(id, fieldData){
  var dataView = new DataView(fieldData)
  switch(id){
    case EF_EXTENDED_TIMESTAMP:
      var flags = dataView.getUint8(0)
      var data = {}
      var offset = 1
      if(flags & 1){
        data.mtime = dataView.getUint32(offset,true)
        offset += 4
      }
      if(flags & 2){
        data.atime = dataView.getUint32(offset,true)
        offset += 4
      }
      if(flags & 4){
        data.ctime = dataView.getUint32(offset,true)
        offset += 4
      }
      return data
      break
    case EF_EXTRA_FIELD_V3:
      var data = {}
      var offset = 1
      data.version = dataView.getUint8(0)
      var uidSize = dataView.getUint8(1)
      data.uid = dataView[uidSize == 4 ? 'getUint32' : uidSize == 2 ? 'getUint16' : 'getUint8'](offset, true)
      offset += uidSize
      var gidSize = dataView.getUint8(1)
      data.gid = dataView[gidSize == 4 ? 'getUint32' : gidSize == 2 ? 'getUint16' : 'getUint8'](offset, true)
      return data
      break
  }
}

// TODO: good thing to separate into a module 
PkzipParser.prototype.read = function(count, endOk){
  var oldCursor = this.cursor
  var currentBuffer = this.cache[this.cacheCursor]
  if(currentBuffer){
    var readEnd = this.cursor + count
    if(readEnd <= currentBuffer[this.lp]){
      this.cursor += count
      return currentBuffer.slice(oldCursor, this.cursor)
    } else {
      var oldCacheCursor = this.cacheCursor
      var oldBuffer = currentBuffer.slice(this.cursor)

      this.cursor = 0
      this.cacheCursor += 1

      //let's hope this recurses safely
      var nextBuffer = this.read(count - oldBuffer[this.lp], endOk)
      if(nextBuffer){
        return combineBuffers(oldBuffer, nextBuffer)
      } else {
        this.cursor = oldCursor
        this.cacheCursor = oldCacheCursor
      }
    }
  }
  if(this.ended && endOk)
    this.emit('error', "read could not be performed on ended stream")
}

function combineBuffers(buf1, buf2){
  if(typeof Buffer != 'undefined' && Buffer.isBuffer(buf1) && Buffer.isBuffer(buf2))
    return Buffer.concat([buf1, buf2], buf1.length + buf2.length)
  else {
    var tmp = new Uint8Array(buf1.length + buf2.length)
    tmp.set(0, new Uint8Array(buf1))
    tmp.set(buf1.byteLength, new Uint8Array(buf2))
    return tmp.buffer
  }
}

function PkzipDataStream(){
  this.readable = true
}
