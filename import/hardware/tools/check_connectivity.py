#!/usr/bin/env python3
"""Check KiCad's exported XML netlist against firmware and recorded hardware.

Run after exporting review/carrier.xml. Independent of the schematic generator.
"""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[2]
xml = ET.parse(root/'hardware/kicad/carrier/review/carrier.xml').getroot()
pin_net = {}
for net in xml.findall('./nets/net'):
    for node in net.findall('node'):
        pin_net[node.get('ref'), node.get('pin')] = net.get('name')
def net(ref, pin): return pin_net[ref, str(pin)]
def same(*pins):
    values=[net(*pin) for pin in pins]
    assert len(set(values)) == 1, (pins, values)

firmware=dict(re.findall(r'#define\s+(\w+)_PIN\s+(\d+)',(root/'firmware/src/main.cpp').read_text()))
gpio_header={42:('J2',6),41:('J2',7),40:('J2',8),2:('J2',3),1:('J2',2),
 39:('J2',9),45:('J2',15),48:('J2',16),47:('J2',17),21:('J2',18),14:('J2',19),
 12:('J1',20),11:('J1',19),10:('J1',18)}
hub={'R1':1,'G1':2,'B1':3,'R2':5,'G2':6,'B2':7,'E':8,'A':9,'B':10,'C':11,'D':12,'CLK':13,'LAT':14,'OE':15}
channels=['R1','G1','B1','R2','G2','B2','A','B','C','D','E','CLK','LAT','OE']
mcu_nets=[]; output_nets=[]
for index,signal in enumerate(channels):
    u='U1' if index<8 else 'U2'; channel=index%8
    socket=gpio_header[int(firmware[signal])]
    same(socket,(u,2+channel))
    same((u,18-channel),(f'R{index+1}',1))
    same((f'R{index+1}',2),('J3',hub[signal]))
    mcu_nets.append(net(*socket));output_nets.append(net('J3',hub[signal]))
    assert net(*socket)!=net('J3',hub[signal]), signal
assert len(set(mcu_nets+output_nets))==28, 'Shorted signal paths'
same(('J1',1),('J2',1),('J3',4),('J3',16),('J4',3),('J4',4),('U1',10),('U2',10))
same(('J1',2),('J1',21))
same(('J4',1),('J4',2),('F1',1))
same(('F1',2),('U1',20),('U2',20),('U3',1))
same(('U3',6),('U3',3),('J2',21),('C4',1))
same(('U3',2),('J1',1))
same(('U3',5),('R28',2));same(('R28',1),('J2',21))
assert not any(ref=='JP1' for ref,pin in pin_net), 'Manual power link must be removed'
assert len({net('J4',1),net('U1',20),net('J2',21),net('J1',2),net('J1',1)})==5
for u in ('U1','U2'):
    same((u,1),(u,10));same((u,19),(u,10))
same(('U2',8),('U2',9),('U2',10))
same(('R27',1),('J1',18));same(('R27',2),('J1',2))
strap_nodes=[pin for pin,n in pin_net.items() if n==net('J2',15)]
assert set(strap_nodes)=={('J2','15'),('U1','8')}, 'Unexpected GPIO45 loading'
print('PASS: all 14 firmware GPIO -> socket -> buffer -> resistor -> HUB75 paths')
print('PASS: grounds, separated power domains, buffer enables / reverse blocker CE feedback, OE pull-up, GPIO45 loading')
print('Electrical topology only: does not validate hardware fit, power sequencing or manufacturing readiness.')
