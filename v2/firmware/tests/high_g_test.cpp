#include "high_g.hpp"
#include <cassert>
#include <cstdio>
static void row(uint8_t data[6],int16_t x,int16_t y,int16_t z) {
 const int16_t v[]={x,y,z};for(int i=0;i<3;i++) {data[2*i]=(uint16_t)v[i]&255;data[2*i+1]=(uint16_t)v[i]>>8;}
}
int main() {
 HighGWindow w;uint8_t data[6];
 assert(w.flags()==0);
 row(data,0,0,96);w.push(data,10); // approximately 1 g, not 96 g
 assert(fabsf(w.latest[2]-9.80665f)<.01f);
 row(data,-20000,1000,0);w.push(data,11);
 assert(w.peak[0]<-2000 && w.peak[1]>100 && w.peak_t_ms==11);
 row(data,0,0,96);w.push(data,12); // latest is small; shock peak must survive
 assert(w.peak[0]<-2000 && w.latest[2]>9);
 assert(w.flags()==5);
 w.clearPeak();assert(w.flags()==1);
 row(data,32767,0,0);w.push(data,13);assert(w.flags()==7);
 assert(fabsf(w.latest[0]/9.80665f-341.333f)<1); // ST FS320 conversion: 10.417 mg/LSB
 row(data,-32768,0,0);w.push(data,14);assert(w.latest[0]<0 && w.saturated);
 puts("High-g: signed ST conversion, all-FIFO peak retention, freshness and saturation passed");
}
