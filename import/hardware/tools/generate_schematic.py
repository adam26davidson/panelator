#!/usr/bin/env python3
"""Generate the review-only carrier schematic with KiCad's installed symbols.

Run explicitly; regeneration replaces carrier.kicad_sch, so preserve GUI edits first.
No third-party Python dependencies. Deterministic UUIDs keep diffs reviewable.
"""
import copy
import json
import math
from pathlib import Path
import re
import uuid

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'kicad/carrier'
LIB = Path('/usr/share/kicad/symbols')
NS = uuid.UUID('e2bfaf57-2828-47f5-bcd3-bfeb40936b83')
def uid(name): return str(uuid.uuid5(NS, name))
def q(s): return json.dumps(str(s), ensure_ascii=False)
def unq(s): return json.loads(s) if s.startswith('"') else s
def parse(s):
    tokens = iter(re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+', s))
    def walk():
        out = []
        for t in tokens:
            if t == ')': return out
            out.append(walk() if t == '(' else t)
        return out
    return walk()[0]
def dump(n): return '(' + ' '.join(dump(x) if isinstance(x,list) else x for x in n) + ')'
def children(n, key): return [x for x in n if isinstance(x,list) and x[0] == key]
def child(n, key): return children(n,key)[0]
def effect(size=1.0, extra=''): return f'(effects (font (size {size} {size})) {extra})'
def extract(lib, name):
    root = parse((LIB/f'{lib}.kicad_sym').read_text())
    return copy.deepcopy(next(s for s in children(root,'symbol') if unq(s[1]) == name))

definitions = {}
def register(lib,name,alias=None):
    n=extract(lib,name)
    key=f'{lib}:{name}' if alias is None else f'Carrier:{alias}'
    n[1]=q(key)
    if alias:
        for sub in children(n,'symbol'): sub[1]=q(unq(sub[1]).replace(name,alias))
        for p in children(n,'property'):
            if unq(p[1])=='Value': p[2]=q(alias)
            if unq(p[1])=='Datasheet': p[2]=q('https://www.ti.com/lit/ds/symlink/sn74ahct541.pdf')
        # A0..A7 / Y0..Y7 are the stock symbol's zero-based channel names.
        # Match the manufacturer's one-based channel names without changing pins.
        for sub in children(n,'symbol'):
            for pin in children(sub,'pin'):
                name_node=child(pin,'name'); name_text=unq(name_node[1])
                # Retain true input / tri-state-output electrical types.
                if re.fullmatch('[AY][0-7]',name_text):
                    name_node[1]=q(name_text[0]+str(int(name_text[1])+1))
    definitions[key]=n
    return key

socket=register('Connector_Generic','Conn_01x21')
hub=register('Connector_Generic','Conn_02x08_Odd_Even')
power=register('Connector_Generic','Conn_01x04')
buffer=register('74xx','74LS541','SN74AHCT541')
ideal=register('Power_Management','LM66100DCK')
res=register('Device','R'); cap=register('Device','C')
fuse=register('Device','Fuse')
flag=register('power','PWR_FLAG')
items=[]; connections={}; seq=0
def add(s): items.append(s)
def note(x,y,text,size=1.27):
    add(f'(text {q(text)} (at {x} {y} 0) {effect(size,"(justify left)")} (uuid {uid(text)}))')
def wire(x,y,ex,ey):
    global seq
    seq+=1
    add(f'(wire (pts (xy {x} {y}) (xy {ex} {ey})) (stroke (width 0) (type default)) (uuid {uid("wire"+str(seq))}))')
def label(x,y,name):
    global seq
    seq+=1
    add(f'(label {q(name)} (at {x} {y} 0) {effect(0.9,"(justify left bottom)")} (uuid {uid("label"+str(seq))}))')
def place(key,ref,value,x,y,nets,footprint='',angle=0,props=None,wired=()):
    n=definitions[key]; pins=[]
    for sub in children(n,'symbol'): pins+=children(sub,'pin')
    a=math.radians(angle)
    def world(px,py):
        return round(x+px*math.cos(a)-py*math.sin(a),4),round(y-px*math.sin(a)-py*math.cos(a),4)
    fields=[]
    for pname,pvalue in [('Reference',ref),('Value',value),('Footprint',footprint),*(props or {}).items()]:
        visible=pname in ('Reference','Value')
        py=y-5.08 if pname=='Reference' else y-2.54
        # Place connector and IC references above the complete symbol body.
        if visible and ref[0] in 'JU':
            top=min(world(float(child(p,'at')[1]),float(child(p,'at')[2]))[1] for p in pins)
            py=top-(5.08 if pname=='Reference' else 2.54)
        fields.append(f'(property {q(pname)} {q(pvalue)} (at {x} {py} {angle % 180}) {effect(1.0,"" if visible else "(hide yes)")})')
    add(f'''(symbol (lib_id {q(key)}) (at {x} {y} {angle}) (unit 1)
      (in_bom {'no' if ref.startswith('#') else 'yes'}) (on_board yes) (dnp no)
      (uuid {uid(ref)}) {' '.join(fields)}
      (instances (project "carrier" (path "/{uid('root')}" (reference {q(ref)}) (unit 1)))))''')
    connections[ref]={}
    coordinates={}
    for pin in pins:
        number=unq(child(pin,'number')[1]); at=child(pin,'at')
        px,py=world(float(at[1]),float(at[2]))
        coordinates[number]=(px,py)
        net=nets.get(number)
        if net is None:
            add(f'(no_connect (at {px} {py}) (uuid {uid(ref+number+"NC")}))')
        elif number in wired:
            connections[ref][number]=net
        else:
            # Extend outward along each pin's orientation, keeping labels off bodies.
            direction=math.radians(float(at[3])+angle)
            ex=round(px-7.62*math.cos(direction),4); ey=round(py+7.62*math.sin(direction),4)
            wire(px,py,ex,ey)
            label(ex,ey,net)
            connections[ref][number]=net
    return coordinates

def join(a,b):
    wire(*a,*b)
def junction(x,y):
    add(f'(junction (at {x} {y}) (diameter 0) (color 0 0 0 0) (uuid {uid(str((x,y)))}))')

note(15,15,'HUB75 carrier — Rev A1 / SCHEMATIC REVIEW ONLY',2.0)
note(15,23,'All component bodies on top. Panel powered directly by split harness. No PCB layout or production BOM yet.')
note(15,32,'DEV BOARD: top view, antenna up / USB down; two 21-pin sockets; 25.4 mm row spacing provisional.')
left={'1':'GND','2':'DEV_3V3','21':'DEV_3V3','18':'MCU_OE','19':'MCU_LAT','20':'MCU_CLK'}
right={'1':'GND','21':'DEV_5V'}
mapping=[('R1',42,'J2',6,1),('G1',41,'J2',7,2),('B1',40,'J2',8,3),
 ('R2',2,'J2',3,5),('G2',1,'J2',2,6),('B2',39,'J2',9,7),
 ('A',45,'J2',15,9),('B',48,'J2',16,10),('C',47,'J2',17,11),
 ('D',21,'J2',18,12),('E',14,'J2',19,8),('CLK',12,'J1',20,13),
 ('LAT',11,'J1',19,14),('OE',10,'J1',18,15)]
for signal,gpio,ref,pin,hpin in mapping:
    (left if ref=='J1' else right)[str(pin)]='MCU_'+signal
place(socket,'J1','DEV LEFT / 21 pins',50.8,76.2,left)
place(socket,'J2','DEV RIGHT / 21 pins',114.3,76.2,right)
note(15,115,'Unused dev-board pins are intentionally unconnected. DEV_3V3 is supplied by the plugged-in board.')

hubnets={'4':'GND','16':'GND'}
for signal,gpio,ref,pin,hpin in mapping: hubnets[str(hpin)]='PANEL_'+signal
place(hub,'J3','HUB75 PANEL OUT',340.36,76.2,hubnets)
note(289,112,'Keyed male 2x8, 2.54 mm; female-female ribbon.')
note(289,119,'Header footprint / key orientation pending verification.')

note(15,132,'POWER — external-to-controller path; USB-host isolation on dev board STILL UNVERIFIED',1.5)
j4=place(power,'J4','BX-VH3.96-4PLT',30.48,160.02,
    {'1':'HARNESS_5V','2':'HARNESS_5V','3':'GND','4':'GND'},angle=180,
    props={'LCSC':'C18077853','Review':'Pin polarity provisional; verify cable'},wired=('1','2','3','4'))
f1=place(fuse,'F1','TBD carrier fuse',83.82,144.78,{'1':'HARNESS_5V','2':'+5V_BUF'},angle=90,wired=('1','2'))
u3=place(ideal,'U3','LM66100DCKR',142.24,147.32,
    {'1':'+5V_BUF','2':'GND','3':'DEV_5V','5':'PWR_PATH_OFF_N','6':'DEV_5V'},
    'Package_TO_SOT_SMD:SOT-363_SC-70-6',wired=('1','3','6'))
# Draw the actual power path; labels are only used for other circuit sections.
for pin in ('1','2'):
    join(j4[pin],(55.88,j4[pin][1]))
join((55.88,j4['1'][1]),(55.88,144.78))
junction(55.88,j4['2'][1])
join((55.88,144.78),f1['1']); label(55.88,144.78,'HARNESS_5V')
join(f1['2'],u3['1']);label(104.14,144.78,'+5V_BUF')
join(u3['6'],(195.58,144.78));label(195.58,144.78,'DEV_5V')
# CE follows VOUT for reverse-current blocking, not ground.
join(u3['3'],(129.54,u3['3'][1]));join((129.54,u3['3'][1]),(129.54,175.26))
join((129.54,175.26),(195.58,175.26));join((195.58,175.26),(195.58,144.78))
junction(195.58,144.78)
for pin in ('3','4'):
    join(j4[pin],(48.26,j4[pin][1]))
join((48.26,j4['3'][1]),(48.26,j4['4'][1]));label(48.26,j4['4'][1],'GND')
c4=place(cap,'C4','1u / 10V',177.8,160.02,{'1':'DEV_5V','2':'GND'},
    'Capacitor_SMD:C_0603_1608Metric',wired=('1',))
join(c4['1'],(177.8,144.78));junction(177.8,144.78)
place(cap,'C1','10u / 10V',228.6,157.48,{'1':'+5V_BUF','2':'GND'},'Capacitor_SMD:C_0805_2012Metric')
place(cap,'C2','100n / 16V',269.24,157.48,{'1':'+5V_BUF','2':'GND'},'Capacitor_SMD:C_0603_1608Metric')
place(cap,'C3','100n / 16V',307.34,157.48,{'1':'+5V_BUF','2':'GND'},'Capacitor_SMD:C_0603_1608Metric')
place(res,'R28','100k',266.7,177.8,{'1':'DEV_5V','2':'PWR_PATH_OFF_N'},'Resistor_SMD:R_0603_1608Metric',angle=90)
note(15,183,'U3 blocks sustained DEV_5V -> harness current. It does NOT isolate DEV_5V from the dev board USB sockets.')
note(15,190,'Simultaneous USB/external power requires verified reverse blocking INSIDE dev board, or an isolated USB interface.')
note(15,197,'J4 polarity, fuse rating, USB inrush/load, regulator headroom and all power transitions remain release gates.')

note(15,207,'LEVEL SHIFTING — AHCT541 inputs tolerate powered GPIOs with buffer VCC = 0; both /OE pins low',1.5)

for k,signals in enumerate([mapping[:8],mapping[8:]]):
    nets={'1':'GND','19':'GND','20':'+5V_BUF','10':'GND'}
    for i in range(8):
        nets[str(2+i)]='MCU_'+signals[i][0] if i<len(signals) else 'GND'
        if i<len(signals): nets[str(18-i)]='BUF_'+signals[i][0]
    place(buffer,f'U{k+1}','SN74AHCT541PWR',60.96+k*96.52,248.92,nets,'Package_SO:TSSOP-20_4.4x6.5mm_P0.65mm')

for i,(signal,*_) in enumerate(mapping):
    col=i//7; row=i%7
    place(res,f'R{i+1}','33R',187.96+col*68.58,48.26+row*10.16,
          {'1':'BUF_'+signal,'2':'PANEL_'+signal},'Resistor_SMD:R_0603_1608Metric',angle=90)

# Bias while GPIOs are high impedance; GPIO45 strap loading remains untouched.
bias_signals=[row[0] for row in mapping if row[0] not in ('A','OE')]+['OE']
for i,signal in enumerate(bias_signals):
    col=i%3; row=i//3
    place(res,f'R{i+15}','10k',220.98+col*63.5,218.44+row*10.16,
          {'1':'MCU_'+signal,'2':'DEV_3V3' if signal=='OE' else 'GND'},
          'Resistor_SMD:R_0603_1608Metric',angle=90)

# Power flags describe intended supplies across passive connectors/protection only.
for i,net in enumerate(['+5V_BUF','GND']):
    place(flag,f'#FLG0{i+1}','PWR_FLAG',350.52+i*38.1,157.48,{'1':net})
note(169,120,'R1-R14: 33 ohm starting values; tune with actual cable.')
note(15,278,'REVIEW GATES: boot blanking / input bias; GPIO45 strap loading; power sequencing; USB isolation; connector footprints.',1.1)
note(15,284,'OE pull-up blanks during high-Z reset only with stable supplies. Power-ramp / missing-controller blanking remains unresolved.',1.1)

root=f'''(kicad_sch (version 20250114) (generator "eeschema") (uuid {uid('root')})
 (paper "A3") (title_block (title "ESP32-S3 HUB75 carrier — review draft") (date "2026-09-19") (rev "A1-DRAFT"))
 (lib_symbols {' '.join(dump(n) for n in definitions.values())})
 {' '.join(items)}
 (sheet_instances (path "/" (page "1"))))'''
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'carrier.kicad_sch').write_text(root+'\n')
if not (OUT/'carrier.kicad_pro').exists():
    (OUT/'carrier.kicad_pro').write_text(json.dumps({'meta':{'filename':'carrier.kicad_pro','version':1}},indent=2)+'\n')
# Save the derived symbol locally so KiCad can resolve and update it.
custom=copy.deepcopy(definitions[buffer]);custom[1]=q('SN74AHCT541')
(OUT/'Carrier.kicad_sym').write_text('(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor") '+dump(custom)+')\n')
(OUT/'sym-lib-table').write_text('(sym_lib_table (version 7) (lib (name "Carrier") (type "KiCad") (uri "${KIPRJMOD}/Carrier.kicad_sym") (options "") (descr "Carrier project symbols")))\n')
print(f'Generated {OUT / "carrier.kicad_sch"}')
