SET TIME ZONE 'UTC';
CREATE SCHEMA shiftly_schema;
CREATE SCHEMA shiftly_api;
CREATE TABLE shiftly_schema.shift_periods (id int, start_date date, end_date date, division_id int, department_id int, status text DEFAULT 'APPROVED');
CREATE TABLE shiftly_schema.users (id int, staff_type_id int, is_active boolean, user_name text, user_desc text);
CREATE TABLE shiftly_schema.staff_types (id int, staff_type_name text, is_active boolean);
CREATE TABLE shiftly_schema.user_managers (manager_user_id int, division_id int, department_id int, is_active boolean);
CREATE TABLE shiftly_schema.user_divisions (user_id int, division_id int, is_active boolean);
CREATE TABLE shiftly_schema.user_department (user_id int, department_id int, is_active boolean);
CREATE TABLE shiftly_schema.shift_types (id int, start_time time, end_time time, day_type text, is_active boolean, shift_label text, shift_code text);
CREATE TABLE shiftly_schema.staff_shift_rules (id int, division_id int, department_id int, staff_type_id int, shift_type_id int, required_staff_count int, is_active boolean);
CREATE TABLE shiftly_schema.shift_assignments (id int, shift_period_id int, shift_date date, division_id int, department_id int, staff_type_id int, shift_type_id int, status text, is_absence int, start_time time, end_time time, user_id int);
CREATE TABLE shiftly_schema.shift_requests (id int, request_type text, request_status text, requested_by_user_id int, requested_shift_date date, requested_shift_type_id int, requested_department_id int, division_id int, inbox_user_id int, shift_assignment_id int, source_shift_assignment_id int, target_shift_assignment_id int);
CREATE TABLE shiftly_schema.shift_assignment_user_history (id int, shift_request_id int, shift_assignment_id int, change_reason text);
CREATE TABLE shiftly_schema.shift_assignment_capacity_groups (id int, shift_period_id int, shift_date date, division_id int, department_id int, staff_type_id int, shift_type_id int, required_staff_count int, pending_required_staff_count int, capacity_status text);
CREATE TABLE shiftly_schema.clinical_encounters (id int, division_id int, department_id int, encounter_status text, admitted_at timestamp, discharged_at timestamp);
CREATE TABLE shiftly_schema.clinical_encounter_locations (id int, encounter_id int, division_id int, department_id int, started_at timestamp, ended_at timestamp);
CREATE FUNCTION shiftly_api.fn_user_has_permission(integer,text) RETURNS boolean LANGUAGE sql AS 'SELECT $1 = 1';
CREATE FUNCTION shiftly_api.fn_user_can_access_division_department(integer,integer,integer) RETURNS boolean LANGUAGE sql AS 'SELECT $1 IN (1,2)';
CREATE FUNCTION shiftly_api.find_active_shift_period_for_date(p_date date, p_division_id int, p_department_id int) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT sp.id FROM shiftly_schema.shift_periods sp
  WHERE p_date BETWEEN sp.start_date AND sp.end_date AND upper(sp.status) IN ('APPROVED', 'GENERATED')
    AND sp.division_id = p_division_id AND sp.department_id = p_department_id
  ORDER BY sp.start_date ASC LIMIT 1;
$$;
INSERT INTO shiftly_schema.shift_periods VALUES (1,CURRENT_DATE-9,CURRENT_DATE+1,1,1);
INSERT INTO shiftly_schema.staff_types VALUES (1,'Admin',true);
INSERT INTO shiftly_schema.users VALUES (1,1,true),(2,1,true);
INSERT INTO shiftly_schema.shift_types (id,start_time,end_time,day_type,is_active) VALUES (1,'07:00','19:00','ANY',true),(2,'19:00','07:00','ANY',true);
INSERT INTO shiftly_schema.staff_shift_rules VALUES (1,1,1,1,1,8,true),(2,1,1,1,2,4,true);


UPDATE shiftly_schema.shift_types SET shift_label=CASE id WHEN 1 THEN 'Day 12h' WHEN 2 THEN 'Night 12h' END;
