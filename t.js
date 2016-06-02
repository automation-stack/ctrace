var child = require('child_process');
var cp = child.exec('ping ya.ru');
cp.stdout.on('data', function(data) {
    console.log(data);
});
