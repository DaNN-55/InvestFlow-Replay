// Adapter for the pinned klinecharts 9.8 axis API; mirrors its native axis drag.
export function zoomReplayYAxisAt(chart,event) {
  if(!chart||!event.deltaY) return false;
  for(const pane of chart.getAllDrawPanes()) {
    const box=chart.getDom(pane.getId(),'yAxis')?.getBoundingClientRect();
    if(!box||event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom) continue;
    const axis=pane.getAxisComponent(),range=axis.getRange();
    if(!axis.getScrollZoomEnabled()||!Number.isFinite(range.range)||range.range<=0) return false;
    const factor=Math.exp(Math.max(-240,Math.min(240,event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?box.height:1)))*0.002);
    const size=range.range*factor,center=(range.from+range.to)/2,from=center-size/2,to=center+size/2;
    if(!Number.isFinite(size)||size<1e-10||size>1e18) return false;
    const realFrom=axis.convertToRealValue(from),realTo=axis.convertToRealValue(to);
    axis.setRange({from,to,range:size,realFrom,realTo,realRange:realTo-realFrom});
    chart.adjustPaneViewport(false,true,true,true);return true;
  }
  return false;
}
