import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCloudStore,
  createConfiguredCloudStore,
  hasCloudConfiguration,
  normalizeProjectName,
  prepareLayoutSnapshot,
  resolveAuthRedirectUrl,
} from '../src/cloud-store.js';

test('cloud store stays disabled without public Supabase configuration', () => {
  assert.equal(createCloudStore(), null);
  assert.equal(hasCloudConfiguration({}), false);
});
test('auth redirects preserve the configured deployment base path', () => {
  assert.equal(
    resolveAuthRedirectUrl('./', 'https://room.example/tools/room-studio/?code=secret#fragment'),
    'https://room.example/tools/room-studio/',
  );
  assert.equal(
    resolveAuthRedirectUrl('/room-studio/', 'https://room.example/other/path'),
    'https://room.example/room-studio/',
  );
});

test('configured cloud clients use public values and PKCE', async () => {
  let options;
  const store = await createConfiguredCloudStore({
    env: {
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    },
    clientFactory(url, key, clientOptions) {
      options = { url, key, clientOptions };
      return { auth: {} };
    },
  });
  assert.ok(store);
  assert.deepEqual(options, {
    url: 'https://project.supabase.co',
    key: 'sb_publishable_test',
    clientOptions: {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    },
  });
});

test('project names are trimmed, collapsed, bounded, and never blank', () => {
  assert.equal(normalizeProjectName('  우리   집  '), '우리 집');
  assert.equal(normalizeProjectName('   '), '내 집 도면');
  assert.equal(normalizeProjectName('가'.repeat(100)).length, 80);
});

test('layout snapshots keep only persisted drawing data and are independent copies', () => {
  const source = {
    zones: [{ id: 'zone-1' }],
    items: [{ id: 'item-1' }],
    structures: [],
    dimensions: [{ id: 'dimension-1' }],
    backgroundPlan: { dataUrl: 'data:image/jpeg;base64,AA==' },
    wallHeight: 260,
    selection: { kind: 'item', id: 'item-1' },
  };
  const snapshot = prepareLayoutSnapshot(source);
  source.zones[0].id = 'changed';
  assert.deepEqual(snapshot, {
    zones: [{ id: 'zone-1' }],
    items: [{ id: 'item-1' }],
    structures: [],
    dimensions: [{ id: 'dimension-1' }],
    backgroundPlan: { dataUrl: 'data:image/jpeg;base64,AA==' },
    wallHeight: 260,
  });
});

test('layout snapshots reject malformed project data', () => {
  assert.throws(() => prepareLayoutSnapshot({ zones: [] }), /유효한 도면/);
});

test('cloud store sends magic-link and Google login requests with the current redirect URL', async () => {
  const calls = [];
  const store = createCloudStore({
    client: {
      auth: {
        signInWithOtp: async (input) => { calls.push(['otp', input]); return { data: {}, error: null }; },
        signInWithOAuth: async (input) => { calls.push(['oauth', input]); return { data: {}, error: null }; },
      },
    },
  });
  await store.signInWithMagicLink(' user@example.com ', 'https://room.example');
  await store.signInWithGoogle('https://room.example');
  assert.deepEqual(calls, [
    ['otp', { email: 'user@example.com', options: { emailRedirectTo: 'https://room.example' } }],
    ['oauth', { provider: 'google', options: { redirectTo: 'https://room.example' } }],
  ]);
});

test('manual cloud saves persist an owned project and an immutable version snapshot', async () => {
  let rpcCall;
  const store = createCloudStore({
    client: {
      auth: {
        getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
      },
      async rpc(name, parameters) {
        rpcCall = { name, parameters };
        return { data: [{ id: 'project-1', name: parameters.p_name, revision: 4 }], error: null };
      },
    },
  });
  const project = await store.saveProject({
    id: 'project-1',
    name: '  우리   집  ',
    layout: { zones: [], items: [], structures: [], dimensions: [], backgroundPlan: null, wallHeight: 250 },
    expectedRevision: 3,
    createVersion: true,
  });
  assert.equal(project.revision, 4);
  assert.deepEqual(rpcCall, {
    name: 'save_project',
    parameters: {
      p_project_id: 'project-1',
      p_name: '우리 집',
      p_layout_json: { zones: [], items: [], structures: [], dimensions: [], backgroundPlan: null, wallHeight: 250 },
      p_schema_version: 2,
      p_expected_revision: 3,
      p_create_version: true,
    },
  });
});
