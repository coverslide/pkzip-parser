var pkzip = require('./')
var fs = require('fs')

var st = fs.createReadStream('./example.zip', {bufferSize:1024 * 2 })

var unzip = new pkzip(st)

unzip.on('file', function(status){
//  console.log(status.fileName)
  status.stream.on('end',function(){
//    console.log('E REACHED')
  })
  status.stream.on('data', function(d){
  //  console.log(d)
  })
})
