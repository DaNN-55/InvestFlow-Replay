export const REPLAY_PRICE_LINE_GROUP = 'replay-controlled-price-lines';
// Space labels independently from their exact price lines. A leader joins a
// displaced label to its price, so nearby entry/stop/profit levels remain legible.
function tagPosition(line,yAxis,height,fallback) {
  if(!yAxis||!line.levels?.length) return fallback;
  const levels=line.levels.map(level=>({...level,y:yAxis.convertToPixel(Number(level.price))})).sort((a,b)=>a.y-b.y);
  const gap=Math.min(22,(height-24)/Math.max(1,levels.length-1));
  for(let i=0;i<levels.length;i++) levels[i].tagY=Math.max(12,Math.min(height-12,levels[i].y),i?levels[i-1].tagY+gap:12);
  for(let i=levels.length-1;i>=0;i--) levels[i].tagY=Math.min(levels[i].tagY,height-12,i<levels.length-1?levels[i+1].tagY-gap:height-12);
  return levels.find(level=>level.id===line.id)?.tagY??fallback;
}
export const REPLAY_PRICE_LINE_OVERLAY = {
  name: 'replayControlledPriceLine', totalStep: 1, lock: true,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures({ coordinates = [], bounding = {}, overlay, yAxis }) {
    const point = coordinates[0], line = overlay.extendData;
    if (!point || !Number.isFinite(point.y)) return [];
    const outside=point.y<0||point.y>bounding.height;
    const edgeY=outside?(point.y<0?14+(line.tagIndex??0)*22:bounding.height-14-(line.tagIndex??0)*22):point.y;
    const y=Math.max(12,Math.min(bounding.height-12,tagPosition(line,yAxis,bounding.height,edgeY)));
    const displaced=Math.abs(y-point.y)>2;
    const tag={ key:'price-tag',type:'text',attrs:{x:8,y,text:`${line.draggable?'↕ ':''}${outside?(point.y<0?'↑ ':'↓ '):''}${line.label}${outside||displaced||line.preview?` @ ${line.price}`:''}`,align:'left',baseline:'middle'},
      styles:{style:'stroke_fill',color:line.color,size:11,backgroundColor:line.background??'#ffffff',borderColor:line.color,borderSize:1,borderRadius:3,paddingLeft:5,paddingRight:5,paddingTop:3,paddingBottom:3},ignoreEvent:!line.draggable };
    // An out-of-range tag names the actual price; never draw a line at a fake
    // clamped price or stretch the candle scale to fit a distant protective stop.
    if(outside) return [tag];
    return [{ key:'price-line',type: 'line', attrs: { coordinates: [{ x: 0, y: point.y }, { x: bounding.width, y: point.y }] },
      styles: { color: line.color, size: 1.5, style: line.dashed ? 'dashed' : 'solid', dashedValue: [6, 4] }, ignoreEvent: !line.draggable },
    tag,...(displaced?[{type:'line',attrs:{coordinates:[{x:5,y},{x:5,y:point.y}]},styles:{color:line.color,size:1},ignoreEvent:true}]:[])];
  },
  createYAxisFigures({coordinates=[],bounding={},overlay,yAxis}) {
    const point=coordinates[0],line=overlay.extendData;
    if(!point||point.y<0||point.y>bounding.height) return [];
    const left=yAxis?.isFromZero()??false;
    return [{type:'text',attrs:{x:left?0:bounding.width,y:point.y,text:String(line.price),align:left?'left':'right',baseline:'middle'},
      styles:{color:'#ffffff',size:10,backgroundColor:line.color,paddingLeft:3,paddingRight:3,paddingTop:3,paddingBottom:3},ignoreEvent:true}];
  },
};
