//
// API
//
function NewStk500Board(serial, pageSize) {
  if (typeof(serial) === "undefined") {
    return { status: Status.Error("serial is undefined") }
  }

  if (typeof(pageSize) === "undefined") {
    return { status: Status.Error("pageSize is undefined") }
  }

  return { status: Status.OK, board: new Stk500Board(serial, pageSize) }
}

Stk500Board.prototype.connect = function(deviceName, doneCb) {
  this.connectImpl_(deviceName, doneCb);
};

Stk500Board.prototype.writeFlash = function(boardAddress, data, doneCb) {
  this.writeFlashImpl_(boardAddress, data, doneCb);
};

Stk500Board.prototype.readFlash = function(boardAddress, length, doneCb) {
  this.readFlashImpl_(boardAddress, length, doneCb);
};

//
// IMPLEMENTATION
//

var STK = {
  OK: 0x10,
  IN_SYNC: 0x14,
  CRC_EOP: 0x20,
  GET_SYNC: 0x30,
  GET_PARAMETER: 0x41,
  FLASH_MEMORY: 0x46,
  ENTER_PROGMODE: 0x50,
  LEAVE_PROGMODE: 0x51,
  LOAD_ADDRESS: 0x55,
  PROG_PAGE: 0x64,
  HW_VER: 0x80,
  SW_VER_MAJOR: 0x81,
  SW_VER_MINOR: 0x82,
};

Stk500Board.State = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected"
};

Stk500Board.prototype.connectionId_ = -1;
Stk500Board.prototype.pageSize_ = -1;
Stk500Board.prototype.readHandler_ = null;
Stk500Board.prototype.serial_ = null;
Stk500Board.prototype.state_ = Stk500Board.State.DISCONNECTED;

function Stk500Board(serial, pageSize) {
  this.serial_ = serial;
  this.pageSize_ = pageSize;
  this.readHandler_ = this.discardData_;
};

//
// COMMON FUNCTIONALITY
//

Stk500Board.prototype.writeAndGetFixedSizeReply_ = function(writePayload, replyBytes, readHandler) {  
  this.setReadHandler_(this.waitForNBytes_(replyBytes, readHandler));
  this.write_(writePayload);
};

Stk500Board.prototype.setReadHandler_ = function(handler) {
  this.readHandler_ = handler;
};

Stk500Board.prototype.handleRead_ = function(readArg) {
  log(kDebugFine, "STK500::HandleRead: [" + binToHex(readArg.data).slice(0,10) + "]");
  if (this.readHandler_ != null) {
    this.readHandler_(readArg);
    return;
  }

  log(kDebugError, "No read handler for: " + JSON.stringify(readArg));
}

Stk500Board.prototype.write_ = function(payload) {
  log(kDebugFine, "STK500::Writing [" + payload.slice(0,10) + "] -> " + this.connectionId_);
  this.serial_.send(
    this.connectionId_, hexToBin(payload), function(writeArg) {
      log(kDebugVeryFine, "WRITE: " + JSON.stringify(writeArg));
      // TODO: veridy writeArg
    });
}

// TODO(mrjones): set a watchdog timeout, so that we can return
// something, rather than hanging forever if we don't get n bytes.
Stk500Board.prototype.waitForNBytes_ = function(n, onFull) {
  var buffer = [];

  return function(readArg) {
    var d = binToHex(readArg.data);
    buffer = buffer.concat(d);

    log(kDebugVeryFine, "Buffered " + d.length + " new bytes. Total is now " +
        buffer.length + ", and waiting for " + n);
    if (buffer.length >= n) {
      // If any data comes in while we're not expecting it, just drop
      // it on the floor.
      this.readHandler_ = this.discardData_;
      onFull({data: buffer});
    }
  }
}

Stk500Board.prototype.discardData_ = function(readArg) {
  log(kDebugError, "STK500::Got data from board when none was expected: " +
      binToHex(readArg));
}

//
// CONNECTION ESTABLISHMENT
//
Stk500Board.prototype.connectImpl_ = function(deviceName, doneCb) {
  // TODO: Validate doneCb
  // TODO: Validate deviceName?
  if (this.state_ != Stk500Board.State.DISCONNECTED) {
    doneCb(Status.Error("Can't connect. Current state: " + this.state_));
    return;
  }

  log(kDebugFine, "STK500::Connecting");
  this.state_ = Stk500Board.State.CONNECTING;

  var board = this;
  // NOTE: 115200 turns out to be the magic number! It didn't work with
  // other values.
  this.serial_.connect(deviceName, { bitrate: 115200 }, function(connectArg) {
    board.serialConnected_(connectArg, doneCb);
  });
}

Stk500Board.prototype.serialConnected_ = function(connectArg, doneCb) {
  console.log(JSON.stringify(connectArg));
  if (typeof(connectArg) == "undefined" ||
      typeof(connectArg.connectionId) == "undefined" ||
      connectArg.connectionId == -1) {
    console.log("error");
    doneCb(Status.Error("Unable to connect to device!"));
    return;
  }

  log(kDebugVeryFine, "STK500::SerialConnected " + connectArg.connectionId);

  this.connectionId_ = connectArg.connectionId;

  // TODO: be more careful about removing this listener
  this.serial_.onReceive.addListener(
    this.handleRead_.bind(this));

  this.twiddleControlLines_(doneCb);
}

Stk500Board.prototype.twiddleControlLines_ = function(doneCb) {
  var cid = this.connectionId_;
  var serial = this.serial_;
  var board = this;
  log(kDebugNormal, "STK500::WaitingToTwiddleControlLines (2 seconds)");
  setTimeout(function() {
    log(kDebugFine, "STK500::TwiddlingControlLines");
    serial.setControlSignals(cid, {dtr: false, rts: false}, function(ok) {
      if (!ok) {
        doneCb(Status.Error("Couldn't set dtr/rts low"));
        return;
      }
      log(kDebugVeryFine, "STK500::DTR is false");
      setTimeout(function() {
        serial.setControlSignals(cid, {dtr: true, rts: true}, function(ok) {
          if (!ok) {
            doneCb(Status.Error("Couldn't set dtr/rts high"));
            return;
          }
          log(kDebugVeryFine, "STK500::DTR is true");
          setTimeout(function() { board.getSync_(doneCb, 0); }, 250);
        });
      }, 250);
    });
  }, 2000);
}

Stk500Board.prototype.getSync_ = function(doneCb, attempts) {
  log(kDebugVeryFine, "STK500::GetSync #" + attempts);
  var board = this;
  this.writeAndGetFixedSizeReply_(
    [ STK.GET_SYNC, STK.CRC_EOP ],
    2,
    function(readArg) {
      var data = binToHex(readArg.data);
      if (data.length == 2 &&
          data[0] == STK.IN_SYNC && data[1] == STK.OK) {
        log(kDebugNormal, "In Sync.");
        board.validateVersion_(doneCb);
      } else {
        if (attempts < 10) {
          setTimeout(function() {
            board.getSync_(doneCb, attempts + 1);
          }, 50);
        } else {
          // TODO(mrjones): call doneCb with the error
          log(kDebugError, "Couldn't get sync");
        }
      }
    });
}

Stk500Board.prototype.validateVersion_ = function(doneCb) {
  var board = this;
  
  // TODO(mrjones): Think about what to do here ... do we actually care
  // about HW/SW versions?
  this.writeAndGetFixedSizeReply_(
    [STK.GET_PARAMETER, STK.HW_VER, STK.CRC_EOP],
    3,
    function(readArg) {
      log(kDebugNormal, "Hardware version: " + binToHex(readArg.data));
      board.state_ = Stk500Board.State.CONNECTED;
      doneCb(Status.OK);
    });
}

//
// WRITE FLASH
//
Stk500Board.prototype.writeFlashImpl_ = function(boardAddress, data, doneCb) {
  if (this.state_ != Stk500Board.State.CONNECTED) {
    doneCb(Status.Error("Not connected to board: " + this.state_));
    return;
  }

  if (boardAddress % this.pageSize_ != 0) {
    doneCb(Status.Error(
      "boardAddress must be aligned to page size of " + this.pageSize_
        + " (" + boardAddress + " % " + this.pageSize_ + " == "
        + (boardAddress % this.pageSize_) + ")"));
    return;
  }

  if (data.length % this.pageSize_ != 0) {
    return doneCb(Status.Error(
      "data size must be aligned to page size of " + this.pageSize_
        + " (" + data.length + " % " + this.pageSize_ + " == "
        + (data.length % this.pageSize_) + ")"));
  }

  log(kDebugFine, "STK500::WriteFlash (" + data.length + " bytes)");

  var board = this;
  this.writeAndGetFixedSizeReply_(
    [STK.ENTER_PROGMODE, STK.CRC_EOP],
    2,
    function(readArg) {
      var d = binToHex(readArg.data);
      if (d.length == 2 && d[0] == STK.IN_SYNC && d[1] == STK.OK) {
        board.writePage_(boardAddress, data, 0, doneCb)
      } else {
        return doneCb(Status.Error(
          "Error entering program mode: " + hexRep(response)));
      }
    });
}

Stk500Board.prototype.writePage_ = function(dataStart, data, pageNo, doneCb) {
  log(kDebugNormal, "==== STK500::WritePage: " + pageNo);
  this.writePageAddress_(dataStart, data, pageNo, doneCb);
}

Stk500Board.prototype.writePageAddress_ = function(dataStart, data, pageNo, doneCb) {
  log(kDebugFine, "-- STK500::LoadAddress " + pageNo);
  var address = dataStart + (this.pageSize_ * pageNo);

  var addressLo = address & 0x00FF;
  var addressHi = (address & 0xFF00) >> 8;

  var board = this;
  this.writeAndGetFixedSizeReply_(
    [STK.LOAD_ADDRESS, addressHi, addressLo, STK.CRC_EOP],
    2,
    function(readArg) {
      var d = binToHex(readArg.data);
      if (d.length == 2 && d[0] == STK.IN_SYNC && d[1] == STK.OK) {
        board.writePageData_(dataStart, data, pageNo, doneCb);
      } else {
        doneCb(Status.Error(
          "Error loading address for page #" + pageNo + ": " + data));
      }
    });
}

Stk500Board.prototype.writePageData_ = function(dataStart, data, pageNo, doneCb) {
  log(kDebugFine, "-- STK500::WritePageData");
  var relativeOffset = this.pageSize_ * pageNo;
  var payload = data.slice(relativeOffset, relativeOffset + this.pageSize_);

  var sizeLo = (this.pageSize_ & 0x00FF);
  var sizeHi = (this.pageSize_ & 0xFF00) >> 8;

  var message = [ STK.PROG_PAGE, sizeHi, sizeLo, STK.FLASH_MEMORY ];
  message = message.concat(payload);
  message.push(STK.CRC_EOP);

  var board = this;
  this.writeAndGetFixedSizeReply_(
    message,
    2,
    function(readArg) {
      var d = binToHex(readArg.data);
      if (d.length == 2 && d[0] == STK.IN_SYNC && d[1] == STK.OK) {
        if (relativeOffset + board.pageSize_ >= data.length) {
          return board.doneWriting_(doneCb);
        } else {
          return board.writePage_(dataStart, data, pageNo + 1, doneCb);
        }
      } else {
        doneCb(Status.Error(
          "Error flashing page #" + pageNo + ": " + data));
        return;
      }
    });
}

Stk500Board.prototype.doneWriting_ = function(doneCb) {
  this.readHandler_ = null
  doneCb(Status.OK);
}

//
// READ FLASH
//
Stk500Board.prototype.readFlash = function(boardAddress, length, doneCb) {
  this.readFlashImpl_(boardAddress, length, doneCb);
  if (this.state_ != Stk500Board.State.CONNECTED) {
    return Status.Error("Not connected to board: " + this.state_);
  }

  log(kDebugError, "Not implemented");
};
