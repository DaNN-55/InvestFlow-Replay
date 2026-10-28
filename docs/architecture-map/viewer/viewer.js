(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('map-data').textContent);
  const $ = id => document.getElementById(id);
  const byId = items => new Map(items.map(item => [item.id, item]));
  const nodes = byId(data.nodes), edges = byId(data.edges), sources = byId(data.sources);
  const statusNames = {fact: '已确认事实', inference: '有依据的推断', unknown: '尚未确认'};
  const kindNames = {entry: '入口', module: '核心模块', store: '数据存储', service: '外部服务', job: '后台任务', object: '业务对象'};
  const evidenceNames = {static: '静态代码', config: '配置', docs: '文档', test: '测试', runtime: '运行观察'};
  const typeNames = {sync: '同步调用', async: '异步处理', data: '数据关系'};
  const state = {view: 'modules', scenario: null, step: null, history: [], expanded: new Set(), manualExpanded: new Set(),
    filter: 'all', selection: null, x: 0, y: 0, scale: 1, visible: [], renderedEdges: []};
  const svg = $('canvas'), viewport = $('viewport'), inspector = $('inspector');
  const W = 196, H = 100;
  let drag = null, suppressClick = false;

  function el(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined && text !== null) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function svgEl(tag, attrs = {}, text) {
    const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value);
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function button(text, action, className) {
    const item = el('button', text, className);
    item.addEventListener('click', action);
    return item;
  }
  function lines(text, size) {
    const chars = Array.from(text);
    const result = [];
    while (chars.length && result.length < 2) result.push(chars.splice(0, size).join(''));
    if (chars.length) result[result.length - 1] = result.at(-1).slice(0, -1) + '…';
    return result;
  }
  function currentScenario() { return data.scenarios.find(s => s.id === state.scenario); }
  function currentStep() { return currentScenario()?.steps.find(s => s.id === state.step); }
  function children(id) { return data.nodes.filter(n => n.parentId === id); }
  function matchesView(node) { return (node.kind === 'object') === (state.view === 'objects'); }
  function position(node) {
    const list = data.nodes.filter(n => (n.kind === 'object') === (node.kind === 'object'));
    const index = list.indexOf(node);
    return node.position || {x: (index % 3) * 290, y: Math.floor(index / 3) * 190};
  }
  function representative(id, visible) {
    let node = nodes.get(id);
    while (node && !visible.has(node.id)) node = nodes.get(node.parentId);
    return node?.id;
  }
  function reveal(id) {
    let node = nodes.get(id);
    while (node?.parentId) { state.expanded.add(node.parentId); node = nodes.get(node.parentId); }
  }
  function visibleNode(node) {
    if (!matchesView(node)) return false;
    const scenario = currentScenario();
    if (scenario) {
      const scope = new Set(scenario.steps.flatMap(step => step.nodeIds));
      for (const id of [...scope]) {
        let parent = nodes.get(id)?.parentId;
        while (parent) { scope.add(parent); parent = nodes.get(parent)?.parentId; }
      }
      if (!scope.has(node.id)) {
        let parent = node.parentId, requested = false;
        while (parent) {
          if (scope.has(parent) && state.manualExpanded.has(parent)) requested = true;
          parent = nodes.get(parent)?.parentId;
        }
        if (!requested) return false;
      }
    }
    let parent = node.parentId;
    while (parent) {
      if (!state.expanded.has(parent)) return false;
      parent = nodes.get(parent)?.parentId;
    }
    const relevant = n => n.status === state.filter || data.edges.some(e => e.status === state.filter && (e.from === n.id || e.to === n.id));
    if (state.filter === 'all' || relevant(node)) return true;
    return data.nodes.some(n => {
      if (!relevant(n)) return false;
      let p = n.parentId;
      while (p) { if (p === node.id) return true; p = nodes.get(p)?.parentId; }
      return false;
    });
  }
  function transform() {
    viewport.setAttribute('transform', `translate(${state.x} ${state.y}) scale(${state.scale})`);
    $('zoom-value').textContent = Math.round(state.scale * 100) + '%';
  }
  function fit() {
    if (!state.visible.length) { state.x = 0; state.y = 0; state.scale = 1; transform(); return; }
    const points = state.visible.map(position);
    const left = Math.min(...points.map(p => p.x)) - 35;
    const top = Math.min(...points.map(p => p.y)) - 45;
    const width = Math.max(...points.map(p => p.x + W)) - left + 35;
    const height = Math.max(...points.map(p => p.y + H)) - top + 70;
    const bounds = svg.getBoundingClientRect();
    state.scale = Math.max(.08, Math.min(1.2, (bounds.width - 36) / width, (bounds.height - 60) / height));
    state.x = (bounds.width - width * state.scale) / 2 - left * state.scale;
    state.y = (bounds.height - 45 - height * state.scale) / 2 - top * state.scale;
    transform();
  }
  function zoom(factor, x, y) {
    const bounds = svg.getBoundingClientRect();
    x ??= bounds.width / 2; y ??= bounds.height / 2;
    const scale = Math.max(.08, Math.min(2.5, state.scale * factor));
    state.x = x - (x - state.x) * scale / state.scale;
    state.y = y - (y - state.y) * scale / state.scale;
    state.scale = scale; transform();
  }
  function edgeGeometry(a, b, offset = 0) {
    if (a.x === b.x && a.y === b.y) {
      return {path: `M ${a.x + W - 20} ${a.y} C ${a.x + W + 100} ${a.y - 90}, ${a.x + 40} ${a.y - 90}, ${a.x + 40} ${a.y}`, x: a.x + W / 2, y: a.y - 50};
    }
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      const x1 = a.x + (dx > 0 ? W : 0), x2 = b.x + (dx > 0 ? 0 : W);
      const y1 = a.y + H / 2 + offset, y2 = b.y + H / 2 + offset, mid = (x1 + x2) / 2;
      return {path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`, x: mid, y: (y1 + y2) / 2 - 10};
    }
    const x1 = a.x + W / 2 + offset, x2 = b.x + W / 2 + offset;
    const y1 = a.y + (dy > 0 ? H : 0), y2 = b.y + (dy > 0 ? 0 : H), mid = (y1 + y2) / 2;
    return {path: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`, x: (x1 + x2) / 2 + 16, y: mid - 8 + offset * 1.2};
  }
  function activate(element, action) {
    element.addEventListener('click', event => { if (!suppressClick) { event.stopPropagation(); action(); } });
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); action(); }
    });
  }
  function renderGraph(reset = false) {
    const focusedNode = document.activeElement?.closest('.graph-node')?.dataset.nodeId;
    const focusedEdge = document.activeElement?.closest('.graph-edge')?.dataset.edgeId;
    state.visible = data.nodes.filter(visibleNode);
    const visible = new Set(state.visible.map(n => n.id));
    const step = currentStep();
    const activeNodes = new Set((step?.nodeIds || []).map(id => representative(id, visible)).filter(Boolean));
    const selectedNode = state.selection?.type === 'node' ? state.selection.id : null;
    $('nodes').replaceChildren(); $('edges').replaceChildren();
    state.renderedEdges = [];
    const visibleEdges = data.edges.map(edge => ({edge, from: representative(edge.from, visible), to: representative(edge.to, visible)}))
      .filter(({edge, from, to}) => matchesView(nodes.get(edge.from)) && (state.filter === 'all' || edge.status === state.filter)
        && from && to && (from !== to || edge.from === edge.to));
    for (const {edge, from, to} of visibleEdges) {
      const active = step?.edgeIds.includes(edge.id);
      const selected = state.selection?.type === 'edge' && state.selection.id === edge.id;
      const peers = visibleEdges.filter(item => item.from === from && item.to === to);
      const offset = (peers.findIndex(item => item.edge.id === edge.id) - (peers.length - 1) / 2) * 28;
      const geometry = edgeGeometry(position(nodes.get(from)), position(nodes.get(to)), offset);
      const group = svgEl('g', {class: `graph-edge${active ? ' active' : ''}${selected ? ' selected' : ''}${step && !active ? ' dim' : ''}`, 'data-edge-id': edge.id, role: 'button', tabindex: 0, 'aria-label': `${nodes.get(from).label} → ${nodes.get(to).label}：${edge.label}，${typeNames[edge.type]}，${statusNames[edge.status]}`});
      group.append(svgEl('path', {d: geometry.path, class: 'edge-hit'}), svgEl('path', {d: geometry.path, class: `edge-line ${edge.type}`}));
      const label = edge.label.length > 15 ? edge.label.slice(0, 14) + '…' : edge.label;
      group.append(svgEl('text', {x: geometry.x, y: geometry.y, class: 'edge-label'}, label));
      activate(group, () => inspect('edge', edge.id));
      $('edges').append(group); state.renderedEdges.push(edge.id);
    }
    for (const node of state.visible) {
      const p = position(node), active = activeNodes.has(node.id), childNodes = children(node.id);
      const group = svgEl('g', {class: `graph-node${active ? ' active' : ''}${selectedNode === node.id ? ' selected' : ''}${step && !active && selectedNode !== node.id ? ' dim' : ''}`, transform: `translate(${p.x} ${p.y})`, 'data-node-id': node.id, role: 'button', tabindex: 0, 'aria-label': `${node.label}，${kindNames[node.kind]}，${statusNames[node.status]}`});
      group.append(svgEl('rect', {width: W, height: H, class: 'node-body'}));
      group.append(svgEl('rect', {x: 0, y: 17, width: 3, height: 22, rx: 1.5, class: 'node-accent'}));
      group.append(svgEl('text', {x: 15, y: 19, class: 'node-type'}, kindNames[node.kind]));
      group.append(svgEl('text', {x: 15, y: 42, class: 'node-label'}, node.label.length > 11 ? node.label.slice(0, 10) + '…' : node.label));
      for (const [i, line] of lines(node.summary, 17).entries()) group.append(svgEl('text', {x: 15, y: 61 + i * 13, class: 'node-summary'}, line));
      group.append(svgEl('text', {x: 15, y: 91, class: `node-state ${node.status}`}, statusNames[node.status]));
      activate(group, () => inspect('node', node.id));
      if (childNodes.length) {
        const expander = svgEl('g', {role: 'button', tabindex: 0, 'aria-label': `${state.expanded.has(node.id) ? '收起' : '展开'}${node.label}内部模块`});
        expander.append(svgEl('rect', {x: W - 74, y: 0, width: 74, height: 29, class: 'expand-hit'}));
        expander.append(svgEl('text', {x: W - 12, y: 19, class: 'expand-text'}, state.expanded.has(node.id) ? '收起 −' : `展开 ${childNodes.length} ＋`));
        activate(expander, () => toggleExpand(node.id)); group.append(expander);
      }
      $('nodes').append(group);
    }
    $('empty-graph').hidden = state.visible.length !== 0;
    $('visible-count').textContent = `${state.visible.length} 个节点`;
    $('view-caption').textContent = state.view === 'objects' ? '业务对象' : '模块关系';
    $('view-modules').setAttribute('aria-pressed', String(state.view === 'modules'));
    $('view-objects').setAttribute('aria-pressed', String(state.view === 'objects'));
    if (reset) fit(); else transform();
    if (focusedNode || focusedEdge) {
      const target = [...document.querySelectorAll('.graph-node, .graph-edge')].find(item =>
        focusedNode ? item.dataset.nodeId === focusedNode : item.dataset.edgeId === focusedEdge);
      target?.focus({preventScroll: true});
    }
  }
  function status(item) { return el('div', statusNames[item.status], `status-text ${item.status}`); }
  function sourceList(item) {
    const evidence = el('details', null, 'detail-section');
    evidence.append(el('summary', `查看源码依据（${item.sourceIds.length}）`));
    inspector.append(evidence);
    if (!item.sourceIds.length) evidence.append(el('p', '还没有可引用的来源。'));
    for (const id of item.sourceIds) {
      const source = sources.get(id), wrapper = el('div', null, 'evidence');
      wrapper.append(el('div', evidenceNames[source.kind], 'evidence-kind'));
      const anchor = source.path + (source.line ? ':' + source.line : '');
      wrapper.append(el('code', anchor), el('code', source.locator));
      if (source.note) wrapper.append(el('p', source.note));
      wrapper.append(button('复制定位', async event => {
        const control = event.currentTarget;
        try { await navigator.clipboard.writeText(`${anchor} · ${source.locator}`); control.textContent = '已复制'; }
        catch { control.textContent = '请选中上方定位复制'; }
      }, 'source-copy'));
      evidence.append(wrapper);
    }
  }
  function textList(title, values, collapsed = false) {
    if (!values?.length) return;
    const section = el(collapsed ? 'details' : 'section', null, 'detail-section');
    section.append(el(collapsed ? 'summary' : 'h3', title));
    const list = el('ul');
    values.forEach(value => list.append(el('li', value)));
    section.append(list); inspector.append(section);
  }
  function inspect(type, id) {
    state.selection = {type, id}; inspector.replaceChildren();
    let item;
    if (type === 'node') {
      item = nodes.get(id);
      inspector.append(el('div', kindNames[item.kind], 'eyebrow'), el('h2', item.label), status(item), el('p', item.summary));
      textList('负责什么', item.details); textList('涉及的数据', item.objects, true); textList('状态如何变化', item.lifecycle, true);
      const childNodes = children(id);
      if (childNodes.length) {
        inspector.append(button(state.expanded.has(id) ? '收起内部模块 −' : `展开内部模块（${childNodes.length}）＋`, () => toggleExpand(id), 'inspector-action'));
        textList('包含哪些模块', childNodes.map(n => n.label), true);
      }
      const related = data.edges.filter(e => e.from === id || e.to === id);
      if (related.length) {
        const relations = el('details', null, 'detail-section');
        relations.append(el('summary', `相连模块（${related.length}）`)); inspector.append(relations);
        for (const edge of related) relations.append(button(`${nodes.get(edge.from).label} → ${nodes.get(edge.to).label} · ${edge.label}`, () => inspect('edge', edge.id), 'text-button'));
      }
    } else if (type === 'edge') {
      item = edges.get(id);
      inspector.append(el('div', typeNames[item.type], 'eyebrow'), el('h2', item.label), status(item));
      inspector.append(el('p', `${nodes.get(item.from).label} → ${nodes.get(item.to).label}`));
    } else if (type === 'step') {
      item = currentStep();
      if (!item) return overview();
      inspector.append(el('div', '当前步骤', 'eyebrow'), el('h2', item.title), status(item), el('p', item.description));
    }
    if (item.note) { inspector.append(el('h3', '这条说明的限制'), el('p', item.note)); }
    sourceList(item); renderGraph();
  }
  function toggleExpand(id) {
    if (state.expanded.has(id)) { state.expanded.delete(id); state.manualExpanded.delete(id); }
    else { state.expanded.add(id); state.manualExpanded.add(id); }
    if (state.selection?.type === 'node') inspect('node', state.selection.id);
    renderGraph();
  }
  function overview() {
    state.selection = null; inspector.replaceChildren();
    inspector.append(el('div', '全局概览', 'eyebrow'), el('h2', '项目如何运行'), el('p', data.meta.summary), el('div', null, 'intro-rule'));
    inspector.append(el('p', '点击节点查看职责与来源，点击连线查看调用含义。选择左侧场景，沿步骤追踪一次操作。'));
    inspector.append(el('h3', '这次检查了什么'), el('p', data.meta.scope));
    const counts = {fact: 0, inference: 0, unknown: 0};
    [...data.nodes, ...data.edges].forEach(n => counts[n.status]++);
    const key = el('div', null, 'fact-key');
    Object.entries(counts).forEach(([k, n]) => key.append(el('span', `${statusNames[k]} ${n}`))); inspector.append(key);
    textList('还没有验证什么', data.meta.limitations, true); textList('本次更新', data.changes, true);
    renderGraph();
  }
  function showQuestions() {
    state.selection = null; inspector.replaceChildren();
    inspector.append(el('div', '证据边界', 'eyebrow'), el('h2', `待核实 · ${data.questions.length}`));
    if (!data.questions.length) inspector.append(el('p', '本次未登记待核实项；检查范围和局限仍见地图版本记录。'));
    for (const question of data.questions) {
      const section = el('section', null, 'question');
      section.append(el('h3', question.title), el('p', question.detail), el('p', `需要：${question.neededEvidence}`));
      for (const id of question.nodeIds) section.append(button(`查看 ${nodes.get(id).label}`, () => {
        state.filter = 'all'; $('status-filter').value = 'all';
        clearScenario(nodes.get(id).kind === 'object' ? 'objects' : 'modules');
        reveal(id); inspect('node', id); renderGraph(true);
      }));
      inspector.append(section);
    }
    renderGraph();
  }
  function nextId() {
    const scenario = currentScenario(), step = currentStep();
    if (!step) return null;
    return Object.hasOwn(step, 'nextStepId') ? step.nextStepId : scenario.steps[scenario.steps.indexOf(step) + 1]?.id ?? null;
  }
  function mainPath() {
    const scenario = currentScenario(), result = new Set();
    let step = scenario?.steps[0];
    while (step && !result.has(step.id)) {
      result.add(step.id);
      const id = Object.hasOwn(step, 'nextStepId') ? step.nextStepId : scenario.steps[scenario.steps.indexOf(step) + 1]?.id;
      step = scenario.steps.find(item => item.id === id);
    }
    return result;
  }
  function goStep(id, record = true) {
    const step = currentScenario()?.steps.find(s => s.id === id);
    if (!step) return;
    if (record && state.step) state.history.push(state.step);
    state.step = id; state.filter = 'all'; $('status-filter').value = 'all';
    state.view = nodes.get(step.nodeIds[0]).kind === 'object' ? 'objects' : 'modules';
    step.nodeIds.forEach(reveal); state.selection = null;
    renderNavigator(); renderPlayback(); inspect('step', id); renderGraph(true);
  }
  function selectScenario(id) {
    state.scenario = id; state.step = null; state.history = []; state.expanded.clear(); state.manualExpanded.clear();
    $('scenario-picker').open = true; $('main-steps').open = true; $('branch-steps').open = false;
    goStep(currentScenario().steps[0].id, false);
  }
  function clearScenario(view = state.view) {
    state.scenario = null; state.step = null; state.history = []; state.view = view; state.expanded.clear(); state.manualExpanded.clear();
    $('scenario-picker').open = true;
    renderNavigator(); renderPlayback(); overview(); renderGraph(true);
  }
  function renderNavigator() {
    $('scenario-list').replaceChildren(); $('step-list').replaceChildren(); $('branch-list').replaceChildren();
    data.scenarios.forEach((scenario, i) => {
      const item = button('', () => selectScenario(scenario.id), 'scenario-button');
      item.setAttribute('aria-pressed', String(state.scenario === scenario.id));
      item.append(el('span', String(i + 1).padStart(2, '0'), 'number'), el('span', scenario.label));
      $('scenario-list').append(item);
    });
    const scenario = currentScenario();
    $('scenario-context').textContent = scenario ? `触发：${scenario.trigger}` : '选择一个场景，逐步查看从触发到结果的过程。';
    if (!data.scenarios.length) $('scenario-context').textContent = '本次尚无可确认的运行场景，详见检查局限。';
    $('scenario-steps').hidden = !scenario;
    $('scenario-choice').textContent = scenario?.label ?? '选择运行场景';
    const path = mainPath();
    $('branch-count').textContent = scenario ? scenario.steps.length - path.size : '';
    $('branch-steps').hidden = !scenario || scenario.steps.length === path.size;
    if (scenario && !path.has(state.step)) $('branch-steps').open = true;
    scenario?.steps.forEach((step, i) => {
      const li = el('li'), item = button('', () => goStep(step.id));
      item.setAttribute('aria-current', step.id === state.step ? 'step' : 'false');
      const branch = !path.has(step.id);
      if (branch) li.className = 'branch-step';
      item.append(el('span', branch ? '支' : String(i + 1), 'step-index'), el('span', branch ? `分支 · ${step.title}` : step.title)); li.append(item); $(branch ? 'branch-list' : 'step-list').append(li);
    });
  }
  function renderPlayback() {
    const step = currentStep(); $('playback').hidden = !step;
    if (!step) return;
    const scenario = currentScenario();
    const path = mainPath();
    $('step-counter').textContent = `${path.has(step.id) ? `步骤 ${[...path].indexOf(step.id) + 1} / ${path.size}` : '分支步骤'} · ${statusNames[step.status]}`;
    $('step-title').textContent = step.title; $('step-description').textContent = step.description;
    $('previous').disabled = !state.history.length;
    $('next').disabled = !nextId(); $('next').querySelector('span').textContent = nextId() ? '下一步' : '流程结束';
    $('branch-actions').replaceChildren();
    for (const branch of step.branches || []) $('branch-actions').append(button(`分支：${branch.label} ↗`, () => goStep(branch.targetStepId)));
    if (!nextId()) $('branch-actions').append(el('p', `场景结果：${scenario.outcome}`, 'muted'));
  }
  $('map-title').textContent = data.meta.title; $('summary').textContent = data.meta.summary;
  $('demo-label').hidden = !data.meta.demo;
  $('scenario-count').textContent = String(data.scenarios.length);
  $('question-count').textContent = String(data.questions.length);
  const version = data.meta.commit ? data.meta.commit.slice(0, 8) : '未记录 commit';
  $('snapshot').textContent = `${data.meta.demo ? '示例快照' : '代码快照'} · ${version} · ${data.meta.generatedAt.slice(0, 10)} ▾`;
  const snapshot = $('snapshot-panel');
  for (const [label, value] of [['项目', data.meta.project], ['生成时间', data.meta.generatedAt], ['版本', data.meta.commit || '未记录'], ['未提交修改', data.meta.dirty === null ? '未知 / 不适用' : data.meta.dirty ? '存在' : '无'], ['检查范围', data.meta.scope]]) {
    const line = el('div', null, 'snapshot-entry'); line.append(el('strong', `${label}：`), document.createTextNode(value)); snapshot.append(line);
  }
  if (data.meta.limitations.length) { snapshot.append(el('strong', '检查局限')); const list = el('ul'); data.meta.limitations.forEach(v => list.append(el('li', v))); snapshot.append(list); }
  if (data.changes.length) { snapshot.append(el('strong', '本次更新')); const list = el('ul'); data.changes.forEach(v => list.append(el('li', v))); snapshot.append(list); }
  $('snapshot').addEventListener('click', () => { snapshot.hidden = !snapshot.hidden; $('snapshot').setAttribute('aria-expanded', String(!snapshot.hidden)); });
  $('view-modules').addEventListener('click', () => clearScenario('modules'));
  $('view-objects').addEventListener('click', () => clearScenario('objects'));
  $('overview').addEventListener('click', () => { state.filter = 'all'; $('status-filter').value = 'all'; clearScenario(); });
  $('questions-button').addEventListener('click', showQuestions);
  $('status-filter').addEventListener('change', event => { state.filter = event.target.value; renderGraph(true); });
  $('previous').addEventListener('click', () => { const id = state.history.pop(); if (id) goStep(id, false); });
  $('next').addEventListener('click', () => goStep(nextId()));
  $('step-evidence').addEventListener('click', () => inspect('step', state.step));
  $('zoom-in').addEventListener('click', () => zoom(1.2)); $('zoom-out').addEventListener('click', () => zoom(1 / 1.2));
  $('reset-view').addEventListener('click', fit);
  svg.addEventListener('wheel', event => {
    event.preventDefault(); const bounds = svg.getBoundingClientRect();
    zoom(Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * .002), event.clientX - bounds.left, event.clientY - bounds.top);
  }, {passive: false});
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.graph-node, .graph-edge')) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, startX: state.x, startY: state.y, moved: false};
    suppressClick = false; svg.setPointerCapture(event.pointerId); svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.moved ||= Math.abs(dx) + Math.abs(dy) > 4;
    state.x = drag.startX + dx; state.y = drag.startY + dy; transform();
  });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved; drag = null; svg.classList.remove('dragging');
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    setTimeout(() => { suppressClick = false; }, 0);
  }
  svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('keydown', event => {
    if (event.target !== svg) return;
    if (event.key === '+' || event.key === '=') { zoom(1.2); event.preventDefault(); }
    if (event.key === '-') { zoom(1 / 1.2); event.preventDefault(); }
    if (event.key === '0') { fit(); event.preventDefault(); }
    const shifts = {ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35]};
    if (shifts[event.key]) { const [x, y] = shifts[event.key]; state.x += x; state.y += y; transform(); event.preventDefault(); }
  });
  new ResizeObserver(() => transform()).observe($('canvas').parentElement);
  renderNavigator(); renderPlayback(); overview(); requestAnimationFrame(fit);
})();
