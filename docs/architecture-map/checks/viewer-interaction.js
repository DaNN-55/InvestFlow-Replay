(async () => {
  const $ = id => document.getElementById(id);
  const model = JSON.parse($('map-data').textContent);
  const checks = [];
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const click = element => element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const transform = () => $('viewport').getAttribute('transform');
  const rect = selector => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  click($('view-modules')); await frame();
  const overview = rect('.canvas-wrap');
  click($('zoom-in'));
  $('canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  const before = transform();
  click(document.querySelector('[data-node-id="api"] [aria-label^="展开"]'));
  await frame();
  check(transform() === before, 'expand preserves zoom and pan');
  check(document.querySelector('[data-node-id="ashare"]'), 'expand reveals child');
  click(document.querySelector('[data-node-id="api"]'));
  click(document.querySelector('.inspector-action')); await frame();
  check(transform() === before, 'inspector collapse preserves zoom and pan');
  check(!document.querySelector('[data-node-id="ashare"]'), 'collapse hides child');
  click(document.querySelector('.inspector-action')); await frame();
  check(transform() === before, 'inspector expand preserves zoom and pan');
  check(document.querySelector('#inspector h3').textContent === '负责什么', 'plain responsibility heading');
  const evidence = [...document.querySelectorAll('#inspector details')].find(e => e.querySelector('summary').textContent.startsWith('查看源码依据'));
  check(evidence && !evidence.open, 'source evidence starts collapsed');
  click(evidence.querySelector('summary')); await frame();
  check(evidence.open && evidence.querySelector('code').textContent.includes('backend/'), 'source anchors remain available');
  let steps = 0, branches = 0;
  const heights = new Set();
  for (let i = 0; i < model.scenarios.length; i++) {
    click($('scenario-list').children[i]); await frame();
    const scenario = model.scenarios[i];
    check($('scenario-picker').open, `${scenario.id}: scenario list stays open`);
    check($('main-steps').open, `${scenario.id}: main steps start open`);
    check(!$('branch-steps').open, `${scenario.id}: branches start collapsed`);
    const initial = $('step-title').textContent;
    if (!$('next').disabled) {
      click($('next')); await frame(); click($('previous')); await frame();
      check($('step-title').textContent === initial, `${scenario.id}: previous follows history`);
    }
    for (const step of scenario.steps) {
      const button = [...document.querySelectorAll('#step-list button, #branch-list button')].find(b => b.textContent.includes(step.title));
      if (button.closest('#branch-list')) { $('branch-steps').open = true; }
      click(button); await frame();
      check($('step-title').textContent === step.title, `${step.id}: displayed step`);
      check(document.querySelector('#inspector h2').textContent === step.title, `${step.id}: inspector follows step`);
      check($('step-description').textContent === step.description, `${step.id}: complete description retained`);
      check($('playback').getBoundingClientRect().bottom <= innerHeight + 1 || innerWidth <= 850, `${step.id}: desktop controls in viewport`);
      heights.add(rect('#playback').height);
      check(document.querySelector('.step-copy').scrollHeight <= document.querySelector('.step-copy').clientHeight + 1, `${step.id}: complete copy without inner scrolling`);
      check($('playback').scrollHeight <= $('playback').clientHeight + 1, `${step.id}: complete footer without inner scrolling`);
      for (const branch of step.branches || []) {
        click([...document.querySelectorAll('#step-list button, #branch-list button')].find(b => b.textContent.includes(step.title)));
        click([...$('branch-actions').querySelectorAll('button')].find(b => b.textContent.includes(branch.label))); await frame();
        check($('step-title').textContent === scenario.steps.find(s => s.id === branch.targetStepId).title, `${step.id}: ${branch.label}`);
        check($('branch-steps').open, `${step.id}: active branch is visible`);
        branches++;
      }
      steps++;
    }
  }
  check(getComputedStyle(document.querySelector('.step-copy')).overflowY === 'visible', 'copy does not create a scroll container');
  const shortBounds = rect('#playback');
  const description = $('step-description').textContent;
  $('step-description').textContent = model.scenarios.flatMap(s => s.steps).reduce((a, b) => a.description.length > b.description.length ? a : b).description.repeat(3);
  await frame();
  const longBounds = rect('#playback');
  check(longBounds.height > shortBounds.height, 'footer grows for long content');
  check(innerWidth <= 850 || longBounds.y < shortBounds.y, 'desktop footer grows upward');
  check(document.querySelector('.step-copy').scrollHeight <= document.querySelector('.step-copy').clientHeight + 1, 'long copy is fully displayed');
  const navigation = document.querySelector('.step-controls').getBoundingClientRect();
  const copyEnd = $('step-evidence').getBoundingClientRect();
  check(navigation.left >= copyEnd.right || navigation.top >= copyEnd.bottom, 'navigation does not cover copy');
  $('step-description').textContent = description; await frame();
  check(getComputedStyle(document.querySelector('.step-controls')).flexDirection === 'row', 'step navigation is horizontal');
  click($('view-objects')); await frame();
  check($('view-caption').textContent === '业务对象', 'object view works');
  click(document.querySelector('[data-node-id="o-session"]')); await frame();
  check(document.querySelector('#inspector h2').textContent === '演练会话', 'object inspector works');
  click($('questions-button')); await frame();
  check(document.querySelectorAll('.question').length === model.questions.length, 'unknowns retained');
  click($('overview')); await frame();
  const filter = $('status-filter'); filter.value = 'unknown'; filter.dispatchEvent(new Event('change')); await frame();
  check(!$('empty-graph').hidden, 'empty filter state works');
  filter.value = 'all'; filter.dispatchEvent(new Event('change')); await frame();
  check($('empty-graph').hidden, 'filter reset restores nodes');
  check(document.documentElement.scrollWidth <= innerWidth, 'no horizontal overflow');
  return { viewport: { width: innerWidth, height: innerHeight }, checks: checks.length, scenarios: model.scenarios.length, steps, visitedBranches: branches, footerHeights: [...heights], overviewCanvas: overview, masthead: rect('.masthead'), navigator: rect('.navigator'), inspector: rect('.inspector'), toolbar: rect('.map-toolbar') };
})()
