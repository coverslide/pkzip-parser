var pkzip = require('./')
var fs = require('fs')

var st = fs.createReadStream('./example.zip', {bufferSize: 1023  })

var unzip = new pkzip()

st.pipe(unzip)
st.on('data', function(d){
//  console.log('IN', d)
})

unzip.on('file', function(header, position, stream){
  console.log(header, position, stream)
  stream.on('end',function(){
    console.log('E REACHED')
  })
  stream.on('data', function(d){
    console.log(d)
  })
})
