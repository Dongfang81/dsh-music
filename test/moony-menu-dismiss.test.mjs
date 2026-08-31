import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function setup() {
  let definition, dismissed = 0, selected = null, toggles = 0;
  const effects = [], listeners = new Map();
  const document = {
    addEventListener(type, fn, capture) { listeners.set(type, { fn, capture }); },
    removeEventListener(type, fn, capture) {
      const entry = listeners.get(type);
      if (entry?.fn === fn && entry.capture === capture) listeners.delete(type);
    }
  };
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useRef(current) { return { current }; },
    useEffect(fn) { effects.push(fn); }
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value; } } }, document
  });
  const client = definition.factory(name => name === 'react' ? react : {});
  const inside = {}, arrowChild = {}, outside = {};
  const triggerRef = { current: { contains(target) { return target === arrowChild; } } };
  const tree = client.MoonyPicker({ selectedId: 'classic', triggerRef,
    onDismiss() { dismissed++; }, onSelect(id) { selected = id; }, onToggleAutoMatch() { toggles++; }
  });
  if (tree.props.ref) tree.props.ref.current = { contains(target) { return target === inside; } };
  const cleanups = effects.map(fn => fn());
  return {
    tree, inside, arrowChild, outside, listeners,
    dismissCount: () => dismissed, selection: () => selected, toggleCount: () => toggles,
    pointer(target) { listeners.get('pointerdown')?.fn({ target }); },
    cleanup() { for (const fn of cleanups) fn?.(); }
  };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
}

test('click outside the mounted menu dismisses it without swallowing the click', () => {
  const s = setup(); s.pointer(s.outside);
  assert.equal(s.dismissCount(), 1);
  assert.equal(s.listeners.get('pointerdown').capture, true, 'must work even when the clicked control stops bubbling');
});
test('menu items and auto-match switch remain interactive inside the menu', () => {
  const s = setup(); s.pointer(s.inside);
  nodes(s.tree).find(n => n.props?.['data-moony-choice'] === 'echo').props.onClick();
  nodes(s.tree).find(n => n.props?.role === 'switch').props.onClick({ stopPropagation() {} });
  assert.equal(s.dismissCount(), 0);
  assert.equal(s.selection(), 'echo'); assert.equal(s.toggleCount(), 1);
});
test('arrow is excluded from outside dismissal so its own click closes, not reopens', () => {
  const s = setup(); s.pointer(s.arrowChild);
  assert.equal(s.dismissCount(), 0);
});
test('unmount removes the outside listener', () => {
  const s = setup(); s.pointer(s.outside);
  assert.equal(s.dismissCount(), 1);
  s.cleanup(); s.pointer(s.outside);
  assert.equal(s.listeners.size, 0); assert.equal(s.dismissCount(), 1);
});
