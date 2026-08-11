create or replace function public.delete_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  delete from public.projects
  where id = p_project_id
    and owner_id = current_user_id;

  if not found then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.delete_project(uuid) from public;
grant execute on function public.delete_project(uuid) to authenticated;
