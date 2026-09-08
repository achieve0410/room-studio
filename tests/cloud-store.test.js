import test from 'node:test';
import assert from 'node:assert/strict';
import { createComparisonOption, normalizeConsultation } from '../src/consultation.js';
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
    p_schema_version: 3,
      p_expected_revision: 3,
      p_create_version: true,
    },
  });
});

test('delete project uses the owner-checked RPC boundary', async () => {
  // Given an authenticated cloud adapter
  const calls = [];
  const store = createCloudStore({
    client: {
      auth: {
        getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
      },
      async rpc(name, parameters) {
        calls.push([name, parameters]);
        return { data: null, error: null };
      },
    },
  });

  // When the user deletes one project
  await store.deleteProject('project-1', { expectedUserId: 'user-1' });

  // Then deletion crosses only the authenticated owner-checking function
  assert.deepEqual(calls, [['delete_project', { p_project_id: 'project-1' }]]);
});

test('delete account invokes the authenticated server-side function', async () => {
  // Given a cloud adapter whose Functions client records requests
  const calls = [];
  const store = createCloudStore({
    client: {
      auth: {
        getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
      },
      functions: {
        async invoke(name, options) {
          calls.push([name, options]);
          return { data: { deleted: true }, error: null };
        },
      },
    },
  });

  // When deliberate account deletion is requested
  await store.deleteAccount({ expectedUserId: 'user-1', confirmation: '계정 삭제' });

  // Then the service-role operation remains behind the authenticated Edge Function
  assert.deepEqual(calls, [[
    'delete-account',
    { body: { confirmation: '계정 삭제' } },
  ]]);
});

test('stale expected user blocks a project save before RPC', async () => {
  // Given an auth transition that replaced the user captured by the editor
  let rpcCalls = 0;
  const store = createCloudStore({
    client: {
      auth: {
        getUser: async () => ({ data: { user: { id: 'user-new' } }, error: null }),
      },
      async rpc() {
        rpcCalls += 1;
        return { data: null, error: null };
      },
    },
  });

  // When the stale editor attempts to save as the previous user
  await assert.rejects(() => store.saveProject({
    id: null,
    name: '이전 사용자 도면',
    layout: { zones: [], items: [], structures: [], dimensions: [], backgroundPlan: null, wallHeight: 240 },
    expectedUserId: 'user-old',
  }), /SESSION_CHANGED/);

  // Then no project write reaches Supabase
  assert.equal(rpcCalls, 0);
});

test('cloud saves and loads the full v3 contract while preserving owner and revision arguments', async () => {
  const layout = createComparisonOption({ zones: [], items: [], structures: [], wallHeight: 240 });
  layout.consultation.clientName = 'Client';
  let row;
  const query = {
    select() { return this; }, eq() { return this; },
    async single() { return { data: row, error: null }; },
  };
  const store = createCloudStore({ client: {
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) },
    from() { return query; },
    async rpc(name, params) {
      assert.equal(name, 'save_project');
      assert.equal(params.p_expected_revision, 4);
      assert.equal(params.p_schema_version, 3);
      row = { id: params.p_project_id, schema_version: params.p_schema_version, layout_json: params.p_layout_json };
      return { data: row, error: null };
    },
  } });
  await store.saveProject({ id: 'project', layout, expectedRevision: 4, expectedUserId: 'owner' });
  assert.deepEqual((await store.loadProject('project')).layout_json, layout);
  for (const schema of [1, 2, 3]) {
    row.schema_version = schema;
    assert.deepEqual((await store.loadProject('project')).layout_json, layout);
  }
  for (const schema of [undefined, null, 0, 4, '3']) {
    row.schema_version = schema;
    await assert.rejects(store.loadProject('project'), (error) => error.code === 'UNSUPPORTED_SCHEMA');
  }
  row.schema_version = 3;
  row.layout_json.consultation = { ...normalizeConsultation(), activeOption: 'B' };
  await assert.rejects(store.loadProject('project'));
});

test('cloud rejects invalid and oversized consultation before issuing RPC', async () => {
  let calls = 0;
  const store = createCloudStore({ client: {
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) },
    async rpc() { calls += 1; return { data: {}, error: null }; },
  } });
  const layout = { zones: [], items: [], structures: [], wallHeight: 240, consultation: null };
  await assert.rejects(store.saveProject({ layout }));
  layout.consultation = normalizeConsultation();
  layout.backgroundPlan = { dataUrl: 'x'.repeat(1_048_576) };
  await assert.rejects(store.saveProject({ layout }), (error) => error.code === 'FILE_TOO_LARGE');
  assert.equal(calls, 0);
});
