# Reads the board's console from a serial port and prints one line per line read (spec 106 AC-15, AC-17).
# Runs inside the pinned ESP-IDF image, where pyserial is installed.
#   reader.py <port> reset|passive <max_seconds>
# passive: DTR and RTS are set false before the port opens and never touched: on the CH34x bridge of the test
# board, asserting them resets the board. reset: after opening, RTS (the board's EN) is pulsed so that the
# first boot is read from its start.
import sys
import time

import serial

port, mode, max_seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])

ser = serial.Serial()
ser.port = port
ser.baudrate = 115200
ser.timeout = 0.2
ser.dtr = False
ser.rts = False
ser.open()

if mode == "reset":
    ser.dtr = False
    ser.rts = True
    time.sleep(0.1)
    ser.rts = False

deadline = time.monotonic() + max_seconds
buf = b""
while time.monotonic() < deadline:
    chunk = ser.read(256)
    if not chunk:
        continue
    buf += chunk
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        sys.stdout.write(line.decode("utf-8", "replace").rstrip("\r") + "\n")
        sys.stdout.flush()
