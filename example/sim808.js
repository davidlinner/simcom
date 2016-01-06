const util = require('util');
const EventEmitter = require('events').EventEmitter;
const SimCom = require('simcom').SimCom;

var accelInit = false;

var simcom = new SimCom('/dev/ttyO4');

var watchdog = setTimeout(function(){
	process.exit();
}, 10000)


simcom.on('open', function() {
	console.log('opened');

	clearTimeout(watchdog);

	simcom.startGPRS('smartbro', function(){
		var client = simcom.createTCPConnection('45.118.132.134', 1883);
		console.log('startGPRS');
		client.on('connect', function(){
			console.log('client connected!');
			simcom.enableGPS().then(function(){
				return simcom.startGPSINFO();
			}).then(function(){
				client.write('Success!')
			}).catch(function(error){
				console.log(error);
				process.exit(1);
			});
		});

		client.on('error', function(error){
			console.log(error);
			process.exit(1);
		});

		client.on('data', function(data){
			console.log('GPRS Data: ', data);
			// client.end();
		});

		client.on('close', function(error){
			console.log('client closed');
			simcom.stopGPSINFO();
			client.reconnect();
		});

		simcom.on('gps', function(data) {
			client.write('Gps');
		});
	}, function(error){
		console.log(error);
		process.exit(1)
	})

});

simcom.on('gprs close', function() {
	console.log('gprs closed');
});

simcom.on('error', function(error) {
	console.log(error);
	process.exit(1);
});
 
