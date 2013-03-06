var pkzip = require('./')
var fs = require('fs')

//TODO: Find out why we're randomly getting invalid signatures based on bufferSize
var st = fs.createReadStream('./example.zip', {bufferSize: 1023  })

var unzip = new pkzip()

st.pipe(unzip)

unzip.on('file', function(status){
  var bufferSize = unzip.cache[0].length
  status.stream.on('end',function(){
  //  console.log('E REACHED')
  })
  status.stream.on('data', function(d){
    console.log(d)
  })
})
