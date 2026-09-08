-- Active geometry remains at layout_json's root. B is created explicitly;
-- the sole inactive snapshot never contains document or cloud metadata.
create function public.valid_project_consultation(p_layout jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  consultation jsonb;
  notes jsonb;
  geometry jsonb;
  field_name text;
  option_name text;
  maximum integer;
begin
  if not (p_layout ? 'consultation') then
    return true;
  end if;
  consultation := p_layout -> 'consultation';
  if jsonb_typeof(consultation) is distinct from 'object'
    or (consultation -> 'version') is distinct from '1'::jsonb
    or coalesce(consultation ->> 'activeOption', '') not in ('A', 'B')
    or not coalesce(consultation -> 'recommendedOption' in ('null'::jsonb, '"A"'::jsonb, '"B"'::jsonb), false)
    or jsonb_typeof(consultation -> 'options') is distinct from 'object'
    or (consultation -> 'options') - array['A', 'B'] <> '{}'::jsonb then
    return false;
  end if;

  foreach field_name in array array['businessName', 'clientName', 'requirements'] loop
    maximum := case when field_name = 'requirements' then 8000 else 120 end;
    if jsonb_typeof(consultation -> field_name) is distinct from 'string'
      or char_length(consultation ->> field_name) > maximum then
      return false;
    end if;
  end loop;

  foreach option_name in array array['A', 'B'] loop
    notes := consultation -> 'options' -> option_name;
    if jsonb_typeof(notes) is distinct from 'object' then
      return false;
    end if;
    foreach field_name in array array['label', 'recommendation', 'nextSteps'] loop
      maximum := case when field_name = 'label' then 80 else 4000 end;
      if jsonb_typeof(notes -> field_name) is distinct from 'string'
        or char_length(notes ->> field_name) > maximum then
        return false;
      end if;
    end loop;
  end loop;

  geometry := consultation -> 'inactiveGeometry';
  if geometry = 'null'::jsonb then
    return consultation ->> 'activeOption' = 'A'
      and consultation -> 'recommendedOption' <> '"B"'::jsonb;
  end if;
  if jsonb_typeof(geometry) is distinct from 'object' then
    return false;
  end if;
  return geometry - array['zones', 'items', 'structures', 'dimensions', 'backgroundPlan', 'wallHeight'] = '{}'::jsonb
    and coalesce(jsonb_typeof(geometry -> 'zones') = 'array', false)
    and coalesce(jsonb_typeof(geometry -> 'items') = 'array', false)
    and coalesce(jsonb_typeof(geometry -> 'structures') = 'array', false)
    and coalesce(jsonb_typeof(geometry -> 'wallHeight') = 'number', false)
    and (not (geometry ? 'dimensions') or jsonb_typeof(geometry -> 'dimensions') = 'array')
    and (not (geometry ? 'backgroundPlan') or jsonb_typeof(geometry -> 'backgroundPlan') in ('object', 'null'));
end;
$$;

revoke all on function public.valid_project_consultation(jsonb) from public;
grant execute on function public.valid_project_consultation(jsonb) to authenticated;

alter table public.projects
  alter column schema_version set default 3,
  drop constraint projects_schema_version_check,
  add constraint projects_schema_version_check check (schema_version in (1, 2, 3)),
  add constraint projects_consultation_check check (public.valid_project_consultation(layout_json));

alter table public.project_versions
  alter column schema_version set default 3,
  drop constraint project_versions_schema_version_check,
  add constraint project_versions_schema_version_check check (schema_version in (1, 2, 3)),
  add constraint project_versions_consultation_check check (public.valid_project_consultation(layout_json));
