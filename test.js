var pkzip = require('./')
var fs = require('fs')

//TODO: Find out why we're randomly getting invalid signatures based on bufferSize
var st = fs.createReadStream('./example.zip', {bufferSize: 1023  })

var unzip = new pkzip(st)

unzip.on('file', function(status){
  var bufferSize = unzip.cache[0].length
  console.log(bufferSize * unzip.cacheCursor + unzip.cursor, unzip.offset, status.fileName)
  status.stream.on('end',function(){
  //  console.log('E REACHED')
  })
  status.stream.on('data', function(d){
  //  console.log(d)
  })
})
