alter table public.projects
  alter column schema_version set default 2,
  drop constraint projects_schema_version_check,
  add constraint projects_schema_version_check check (schema_version in (1, 2));

alter table public.project_versions
  alter column schema_version set default 2,
  drop constraint project_versions_schema_version_check,
  add constraint project_versions_schema_version_check check (schema_version in (1, 2));
