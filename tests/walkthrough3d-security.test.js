import test from 'node:test';
import assert from 'node:assert/strict';
import { setStatusMessage } from '../src/walkthrough3d.js';

test('3D status renders user-controlled names as text nodes', () => {
  // Given a hostile project entity name and a status node that rejects HTML assignment
  const created = [];
  const ownerDocument = {
    createElement(tagName) {
      const node = { nodeType: 1, tagName: tagName.toUpperCase() };
      created.push(node);
      return node;
    },
    createTextNode(textContent) {
      const node = { nodeType: 3, textContent };
      created.push(node);
      return node;
    },
  };
  const status = {
    ownerDocument,
    children: [],
    set innerHTML(_value) {
      throw new Error('innerHTML must not be used');
    },
    replaceChildren(...children) {
      this.children = children;
    },
  };
  const hostileName = '<img src=x onerror=globalThis.compromised=true>';

  // When the 3D status is updated
  setStatusMessage(status, `${hostileName} 바로 보기`);

  // Then the icon is structural and the complete untrusted value remains inert text
  assert.equal(created[0].tagName, 'I');
  assert.equal(created[1].nodeType, 3);
  assert.equal(created[1].textContent, ` ${hostileName} 바로 보기`);
  assert.deepEqual(status.children, created);
});
