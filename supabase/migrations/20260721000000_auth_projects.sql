create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  layout_json jsonb not null,
  schema_version integer not null default 1 check (schema_version > 0),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_versions (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  layout_json jsonb not null,
  schema_version integer not null default 1 check (schema_version > 0),
  created_at timestamptz not null default now()
);

create index projects_owner_updated_idx on public.projects(owner_id, updated_at desc);
create index project_versions_project_created_idx on public.project_versions(project_id, created_at desc);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_versions enable row level security;

revoke all on public.profiles from anon;
revoke all on public.projects from anon;
revoke all on public.project_versions from anon;
grant select, update on public.profiles to authenticated;
grant select on public.projects to authenticated;
grant select on public.project_versions to authenticated;

create function public.save_project(
  p_project_id uuid,
  p_name text,
  p_layout_json jsonb,
  p_schema_version integer,
  p_expected_revision bigint,
  p_create_version boolean default false
)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  saved_project public.projects;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if p_project_id is null then
    insert into public.projects (owner_id, name, layout_json, schema_version)
    values (current_user_id, p_name, p_layout_json, p_schema_version)
    returning * into saved_project;
  else
    update public.projects
    set name = p_name,
        layout_json = p_layout_json,
        schema_version = p_schema_version,
        revision = revision + 1
    where id = p_project_id
      and owner_id = current_user_id
      and revision = p_expected_revision
    returning * into saved_project;

    if saved_project.id is null then
      raise exception 'PROJECT_CONFLICT' using errcode = '40001';
    end if;
  end if;

  if p_create_version then
    insert into public.project_versions (project_id, owner_id, layout_json, schema_version)
    values (saved_project.id, current_user_id, p_layout_json, p_schema_version);
  end if;

  return saved_project;
end;
$$;

revoke all on function public.save_project(uuid, text, jsonb, integer, bigint, boolean) from public;
grant execute on function public.save_project(uuid, text, jsonb, integer, bigint, boolean) to authenticated;

create policy "Users can read their own profile"
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);

create policy "Users can update their own profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Users can read their own projects"
on public.projects for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "Users can create their own projects"
on public.projects for insert
to authenticated
with check ((select auth.uid()) = owner_id);

create policy "Users can update their own projects"
on public.projects for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create policy "Users can delete their own projects"
on public.projects for delete
to authenticated
using ((select auth.uid()) = owner_id);

create policy "Users can read their own project versions"
on public.project_versions for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "Users can create their own project versions"
on public.project_versions for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and exists (
    select 1 from public.projects
    where projects.id = project_id
      and projects.owner_id = (select auth.uid())
  )
);
