// vim: ts=2 expandtab
var util = require('util');
var serialport = require('serialport');
var Q = require('q');
var EventEmitter = require('events').EventEmitter;
var net = require('net');

var Modem = (function Modem_cctor() {
    function Modem(device, options) {
      options = options || {};

      if (!options.lineEnd) {
        options.lineEnd = "\r\n";
      }

      if (!options.baudrate) {
        options.baudrate = 115200;
      }

      this.options = options;
      this.opened = false;sudte
      this.device = device;
      this.port = null;
      this.buffer = Buffer.alloc(0);
      this.lines = [];
      this.defers = [];
    }

    util.inherits(Modem, EventEmitter);

    Modem.prototype.open = function(timeout) {
      var self = this;

      if (self.opened) {
        self.emit('open');
        return;
      }

      timeout = timeout || 5000;

      this.port = new serialport(this.device, {
        baudRate: this.options.baudrate,
        parser: serialport.parsers.raw,
//        buffersize: 8192
      });

      this.port.on('open', function() {
        this.on('data', function(data) {
          self.buffer = Buffer.concat([self.buffer, data]);
          readBuffer.call(self);
        });

        self.execute({ command: 'AT', timeout: timeout }).then(function() {
          self.emit('open');
        }).catch(function(error) {
          self.emit('error', error);
        }).done();;
      });

      this.port.on('close', function() {
        self.opened = false;
        self.emit('close');
      });

      this.port.on('error', function(err) {
        self.emit('error', err);
      });

      this.opened = true;
    }

    Modem.prototype.close = function() {
      this.port.close();
      this.port = null;
      instances[this.device] = null;
    }

    Modem.prototype.write = function(data, callback) {
      this.port.write(data, callback);
    }

    Modem.prototype.writeAndWait = function(data, callback) {
      var self = this;
      this.write(data, function() {
        self.port.drain(callback);
      });
    }


    function doExecute(command) {
      var p = null;
      var timeout;

      if (typeof command == 'object') {

        if (command.timeout) {
          timeout = Number(timeout);
        }

        if (command.defers) {
          defer_times = command.defers || 1;
        }

        p = command.pdu;
        command = command.command;

      }
      //
      var defer = Q.defer();

      defer.command = command.split("\r", 1).shift();
      defer.pdu = p;
      this.defers.push(defer);
      this.write(command + "\r");

      if (timeout) {
        setTimeout(function() {
          defer.reject(new Error('timed out'));
        }, timeout);
      }

      return defer.promise;
    }

    Modem.prototype.execute = function(command) {
      return doExecute.call(this, command);
      // TODO: Command queue
    }

    function readBuffer() {
      var lineEndLength = this.options.lineEnd.length;
      //var lineEndPosition = buffertools.indexOf(self.buffer, self.options.lineEnd);
      var lineEndPosition = this.buffer.indexOf(this.options.lineEnd);

      if (lineEndPosition === -1) {
        if (this.buffer.length == 2 && this.buffer.toString() == '> ') {
          processLine.call(this, this.buffer.toString());
        }
        return;
      }

      /*
      if ((lineEndPosition < this.buffer.length - 1) && (this.buffer[lineEndPosition + 1] == 0x0A)) {
        lineEndLength++;
      }
      */

      var line = this.buffer.slice(0, lineEndPosition);
      var newBuffer = Buffer.alloc(this.buffer.length - lineEndPosition - lineEndLength);
      this.buffer.copy(newBuffer, 0, lineEndPosition + lineEndLength);
      this.buffer = newBuffer;

      processLine.call(this, line.toString('ascii'));
      process.nextTick(readBuffer.bind(this));
    }

    var unboundExprs = [
      {
        expr: /^OVER-VOLTAGE WARNNING$/i,
        func: function(m) {
          this.emit('over-voltage warnning');
        }
      },

      {
        expr: /^RING$/i,
        func: function(m) {
          this.ringing = true;
          this.emit('ring');
        }
      },

      {
        expr: /^\+CMTI:(.+)$/i,
        func: function(m) {
          this.emit('new message', m[1]);
        }
      },

      {
        expr: /^\+CPIN: (NOT .+)/i,
        unhandled: true,
        func: function(m) {
          this.emit('sim error', m[1]);
        }
      },

      {
        expr: /^\+CUSD:(.+)$/i,
        func: function(m) {
          this.emit('ussd', m[1]);
        }
      },

      {
        expr: /^\+CIPRXGET: 1/i,
        func: function(m) {
          var self = this;
          this.execute('AT+CIPRXGET=4').then(function(res){
            var s = res.lines[0].replace(/\s+/g, '').split(':')[1].split(',');
            self.emit('gprs data', s[1]);
          });
        }
      },

      {
        expr: /^CLOSED/i,
        func: function(m) {
          this.emit('gprs close', m[1]);
        }
      },

      {
        expr: /^\+PDP:(.+)$/i,
        func: function(m) {
          if(m[1] == ' DEACT')
            this.emit('gprs deact');
        }
      }
    ];

    function processUnboundLine(line) {
      for (var i = 0; i < unboundExprs.length; i++) {
        var u = unboundExprs[i];
        var m = line.match(u.expr);

        if (m) {
          u.func && u.func.call(this, m);

          if (!u.unhandle) {
            this.emit('urc', m, u.expr);
            return true;
          }
        }
      }

      return false;
    }

    function processLine(line) {
      if (line.substr(0, 2) == 'AT') {
        // echo'd line
        return;
      }

      if (processUnboundLine.call(this, line)) {
        return;
      }

      // special handling for ring
      if (this.ringing && line == 'NO CARRIER') {
        this.ringing = false;
        this.emit('end ring');
        return;
      }

      if(line.trim() != '') {
        this.lines.push(line);
      }

      if(net.isIP(line)){
        this.lines.push('OK');
      }

      processLines.call(this);
    }

    function isResultCode(line) {
      return /(^OK|ERROR|BUSY|DATA|NO CARRIER|> $)|(^CONNECT( .+)*$)|(^SEND( .+)*$)|(^SHUT( .+)*$)/i.test(line);
    }

    function processLines() {
      if (!this.lines.length) {
        return;
      }

      if(this.defers[0]){
        var command = this.defers[0].command;
        if( (/^AT\+CIPSTART/).test(command) && this.lines[this.lines.length-1] == 'OK' ){
          this.lines.pop();
          return;
        }
      }

      if (!isResultCode(this.lines[this.lines.length-1])) {
        return;
      }


      if (this.lines[0].trim() == '') {
        this.lines.shift();
      }

      processResponse.call(this);
      this.lines = [];
    }

    function processResponse() {
      var responseCode = this.lines.pop();
      var defer = this.defers[0];

      if (responseCode == '> ') {
        if (defer && defer.pdu) {
          var pduSize = defer.pdu.length;
          var b = Buffer.alloc(pduSize + 1);
          b.write(defer.pdu);
          b.writeUInt8(26, pduSize);
          this.write(b);
          defer.pdu = null;
        }
        return;
      }

      if (responseCode.match(/^CONNECT( .+)*$/i) && !(/^AT\+CIPSTART/).test(defer.command)) {
        if (defer && defer.pdu) {
          this.write(defer.pdu);
          defer.pdu = null;
        }
        return;
      }

      if (defer) {
        this.defers.shift();

        if (responseCode == 'ERROR') {
          defer.reject({ code: responseCode, command: defer.command });
          return;
        }

        defer.resolve({ code: responseCode, command: defer.command, lines: this.lines});
      }
    }

    //
  return Modem;
})();

var instances = {};
var init = function(device, options) {
  device = device || '/dev/ttyAMA0';

  if (!instances[device]) {
    instances[device] = new Modem(device, options);
  }

  return instances[device];
}

module.exports = init;
