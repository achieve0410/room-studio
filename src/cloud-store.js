const DEFAULT_PROJECT_NAME = '내 집 도면';
const runtimeEnv = import.meta.env ?? {};

export function normalizeProjectName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  return name.slice(0, 80) || DEFAULT_PROJECT_NAME;
}

export function prepareLayoutSnapshot(layout) {
  if (!Array.isArray(layout?.zones) || !Array.isArray(layout?.items) || !Array.isArray(layout?.structures)) {
    throw new TypeError('유효한 도면 데이터가 아닙니다.');
  }
  return JSON.parse(JSON.stringify({
    zones: layout.zones,
    items: layout.items,
    structures: layout.structures,
    wallHeight: Number(layout.wallHeight) || 240,
  }));
}

function throwIfError(result) {
  if (result.error) throw result.error;
  return result.data;
}

export function createCloudStore({ client } = {}) {
  if (!client) return null;
  const supabase = client;

  const currentUser = async () => {
    const data = throwIfError(await supabase.auth.getUser());
    if (!data.user) throw new Error('로그인이 필요합니다.');
    return data.user;
  };

  return {
    async getSession() {
      return throwIfError(await supabase.auth.getSession()).session;
    },

    onAuthStateChange(callback) {
      return supabase.auth.onAuthStateChange((_event, session) => callback(session)).data.subscription;
    },

    async signInWithMagicLink(email, redirectTo) {
      return throwIfError(await supabase.auth.signInWithOtp({
        email: String(email).trim(),
        options: { emailRedirectTo: redirectTo },
      }));
    },

    async signInWithGoogle(redirectTo) {
      return throwIfError(await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      }));
    },

    async signOut() {
      throwIfError(await supabase.auth.signOut());
    },

    async listProjects() {
      return throwIfError(await supabase
        .from('projects')
        .select('id,name,revision,updated_at')
        .order('updated_at', { ascending: false }));
    },

    async loadProject(id) {
      const project = throwIfError(await supabase
        .from('projects')
        .select('id,name,layout_json,schema_version,revision,updated_at')
        .eq('id', id)
        .single());
      return { ...project, layout_json: prepareLayoutSnapshot(project.layout_json) };
    },

    async saveProject({ id = null, name, layout, expectedRevision = null, createVersion = false }) {
      await currentUser();
      const snapshot = prepareLayoutSnapshot(layout);
      const result = throwIfError(await supabase.rpc('save_project', {
        p_project_id: id,
        p_name: normalizeProjectName(name),
        p_layout_json: snapshot,
        p_schema_version: 1,
        p_expected_revision: expectedRevision,
        p_create_version: createVersion,
      }));
      return Array.isArray(result) ? result[0] : result;
    },
  };
}

export function hasCloudConfiguration() {
  return Boolean(runtimeEnv.VITE_SUPABASE_URL && runtimeEnv.VITE_SUPABASE_PUBLISHABLE_KEY);
}

export async function createConfiguredCloudStore() {
  if (!hasCloudConfiguration()) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createCloudStore({
    client: createClient(runtimeEnv.VITE_SUPABASE_URL, runtimeEnv.VITE_SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
  });
}
