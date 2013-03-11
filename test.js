var pkzip = require('./')
var fs = require('fs')

var st = fs.createReadStream('./example.zip', {bufferSize: 32*1024  })

var unzip = new pkzip()

st.pipe(unzip)

unzip.on('file', function(header, position, stream){
  process.stdout.write(JSON.stringify(header))
})
