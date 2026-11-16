"""
Generate Comprehensive Company Automation & Job Distribution Excel Report
"""
import os
import sys
import json
import urllib.request
import re
from datetime import datetime
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

def load_env():
    env = {}
    for p in ['.env', 'auto-apply/.env']:
        if os.path.exists(p):
            with open(p, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        parts = line.split('=', 1)
                        k = parts[0].strip()
                        v = parts[1].strip().strip('"\'')
                        if k not in env:
                            env[k] = v
    return env

def fetch_all_job_distributions(supabase_url, supabase_key):
    headers = {
        'apikey': supabase_key,
        'Authorization': f'Bearer {supabase_key}',
        'Content-Type': 'application/json'
    }
    all_rows = []
    page = 0
    page_size = 1000
    while True:
        offset_from = page * page_size
        offset_to = offset_from + page_size - 1
        req_headers = dict(headers)
        req_headers['Range'] = f'{offset_from}-{offset_to}'
        endpoint = f"{supabase_url}/rest/v1/job_distributions?select=id,applywizz_id,company,job_url,status,error_message,created_at,updated_at&order=id.asc"
        req = urllib.request.Request(endpoint, headers=req_headers)
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                if not data:
                    break
                all_rows.extend(data)
                if len(data) < page_size:
                    break
                page += 1
        except Exception as e:
            print(f"Error fetching page {page}: {e}")
            break
    return all_rows

def normalize_company(raw_name, url):
    name = str(raw_name or '').strip()
    if not name and url:
        try:
            from urllib.parse import urlparse
            u = urlparse(url)
            name = u.hostname.split('.')[0]
        except Exception:
            pass
    if not name:
        name = 'Unknown Employer'
    
    # Normalize display name vs key
    norm_key = re.sub(r'[^a-z0-9]', '', name.lower())
    norm_key = norm_key.replace('corporation', 'corp').replace('company', 'co')
    
    # Standard pretty names for known variations
    pretty_mapping = {
        'bostondynamics': 'Boston Dynamics',
        'generalmotors': 'General Motors',
        'generalmotorscareersgm': 'General Motors',
        'samsungsemiconductor': 'Samsung Semiconductor',
        'samsungsemiconductorssi': 'Samsung Semiconductor',
        'zillow': 'Zillow',
        'nvidia': 'NVIDIA',
        'salesforce': 'Salesforce',
        'impactadvisors': 'Impact Advisors',
        'moffittcancercenter': 'Moffitt Cancer Center',
        'repligencorp': 'Repligen Corporation',
        'repligen': 'Repligen Corporation',
        'dulyhealthandcare': 'Duly Health and Care',
        'coloradostateuniversity': 'Colorado State University',
        'thecampbellsco': "The Campbell's Company",
        'campbellsoup': "The Campbell's Company",
        'usfoods': 'US Foods',
        'magnainternational': 'Magna International',
        'synechron': 'Synechron',
        'bluecrossandblueshieldofnebraska': 'Blue Cross and Blue Shield of Nebraska',
        'universityofthecumberlands': 'University of the Cumberlands',
        'clevelandmetropolitanschooldistrict': 'Cleveland Metropolitan School District',
        'integralifesciences': 'Integra LifeSciences',
        'entrustcorp': 'Entrust Corporation',
        'wellsfargo': 'Wells Fargo',
        'chghealthcare': 'CHG Healthcare',
    }
    display_name = pretty_mapping.get(norm_key, name)
    return norm_key, display_name

def generate_report():
    env = load_env()
    supabase_url = env.get('SUPABASE_URL', '').rstrip('/')
    supabase_key = env.get('SUPABASE_SERVICE_ROLE_KEY') or env.get('SUPABASE_KEY')
    
    if not supabase_url or not supabase_key:
        print("Missing Supabase credentials!")
        sys.exit(1)
        
    print("Fetching all job distributions from Supabase...")
    rows = fetch_all_job_distributions(supabase_url, supabase_key)
    print(f"Fetched {len(rows)} total records.")

    company_data = {}
    zoho_rows = []

    for r in rows:
        norm_key, display_name = normalize_company(r.get('company'), r.get('job_url'))
        if norm_key not in company_data:
            company_data[norm_key] = {
                'name': display_name,
                'total': 0,
                'submitted': 0,
                'ready_for_review': 0,
                'needs_answers': 0,
                'applying': 0,
                'already_applied': 0,
                'archived': 0,
                'failed': 0,
                'zoho_not_connected': 0,
                'urls': set(),
                'candidates': set()
            }
        
        c = company_data[norm_key]
        c['total'] += 1
        s = str(r.get('status') or '').lower()
        if s in c:
            c[s] += 1
        
        if r.get('job_url'):
            c['urls'].add(r.get('job_url'))
        if r.get('applywizz_id'):
            c['candidates'].add(r.get('applywizz_id'))

        err = str(r.get('error_message') or '').lower()
        if 'zoho' in err or 'mailbox' in err or s == 'zoho_not_connected':
            c['zoho_not_connected'] += 1
            zoho_rows.append({
                'id': r.get('id'),
                'awl_id': r.get('applywizz_id'),
                'company': display_name,
                'status': r.get('status'),
                'job_url': r.get('job_url'),
                'error_message': r.get('error_message'),
                'created_at': r.get('created_at'),
            })

    # Metrics summary
    total_apps = len(rows)
    total_companies = len(company_data)
    automated_companies = [c for c in company_data.values() if c['submitted'] > 0]
    total_automated_companies = len(automated_companies)
    in_progress_companies = [c for c in company_data.values() if c['submitted'] == 0 and (c['ready_for_review'] > 0 or c['applying'] > 0)]
    
    total_submitted_apps = sum(c['submitted'] for c in company_data.values())
    total_ready_apps = sum(c['ready_for_review'] for c in company_data.values())
    total_needs_answers = sum(c['needs_answers'] for c in company_data.values())
    total_already_applied = sum(c['already_applied'] for c in company_data.values())
    total_archived = sum(c['archived'] for c in company_data.values())
    total_failed = sum(c['failed'] for c in company_data.values())
    total_zoho_not_connected = len(zoho_rows)

    print(f"\n==========================================")
    print(f"AUTOMATION AUDIT SUMMARY:")
    print(f"Total Unique Companies: {total_companies}")
    print(f"Fully Automated Companies (Submitted > 0): {total_automated_companies}")
    print(f"In-Progress Companies (Ready/Applying): {len(in_progress_companies)}")
    print(f"Total Applications Distributed: {total_apps}")
    print(f"Total Applications Submitted End-to-End: {total_submitted_apps}")
    print(f"Total Zoho Not Connected Issues: {total_zoho_not_connected}")
    print(f"==========================================\n")

    # Build OpenPyXL Workbook
    wb = openpyxl.Workbook()
    
    # Styles
    font_title = Font(name='Calibri', size=16, bold=True, color='1E293B')
    font_subtitle = Font(name='Calibri', size=11, italic=True, color='64748B')
    font_header = Font(name='Calibri', size=11, bold=True, color='FFFFFF')
    font_data = Font(name='Calibri', size=10, color='0F172A')
    font_bold = Font(name='Calibri', size=10, bold=True, color='0F172A')
    
    fill_header_navy = PatternFill(start_color='1E3A8A', end_color='1E3A8A', fill_type='solid')
    fill_header_blue = PatternFill(start_color='2563EB', end_color='2563EB', fill_type='solid')
    fill_kpi_label = PatternFill(start_color='F1F5F9', end_color='F1F5F9', fill_type='solid')
    fill_kpi_val = PatternFill(start_color='E2E8F0', end_color='E2E8F0', fill_type='solid')
    fill_green = PatternFill(start_color='DCFCE7', end_color='DCFCE7', fill_type='solid')
    fill_amber = PatternFill(start_color='FEF3C7', end_color='FEF3C7', fill_type='solid')
    fill_red = PatternFill(start_color='FEE2E2', end_color='FEE2E2', fill_type='solid')
    fill_blue_light = PatternFill(start_color='DBEAFE', end_color='DBEAFE', fill_type='solid')
    
    thin_border = Border(
        left=Side(style='thin', color='CBD5E1'),
        right=Side(style='thin', color='CBD5E1'),
        top=Side(style='thin', color='CBD5E1'),
        bottom=Side(style='thin', color='CBD5E1')
    )
    
    align_center = Alignment(horizontal='center', vertical='center')
    align_left = Alignment(horizontal='left', vertical='center')
    align_right = Alignment(horizontal='right', vertical='center')

    # ─────────────────────────────────────────────────────────────
    # SHEET 1: EXECUTIVE SUMMARY
    # ─────────────────────────────────────────────────────────────
    ws_sum = wb.active
    ws_sum.title = "Executive Summary"
    ws_sum.views.sheetView[0].showGridLines = True

    ws_sum['B2'] = "Workday Auto — Company Automation & Job Distribution Audit"
    ws_sum['B2'].font = font_title
    ws_sum['B3'] = f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Real-time Supabase Database Sync"
    ws_sum['B3'].font = font_subtitle

    kpis = [
        ("Total Unique Companies in System", total_companies, fill_kpi_label),
        ("Companies Fully Automated (Submitted > 0)", total_automated_companies, fill_green),
        ("Companies Currently In Progress / Scanning", len(in_progress_companies), fill_amber),
        ("Company End-to-End Automation Rate", f"{round(total_automated_companies / total_companies * 100, 1)}%", fill_blue_light),
        ("Total Candidate Applications Distributed", total_apps, fill_kpi_label),
        ("Total Applications Submitted End-to-End", total_submitted_apps, fill_green),
        ("Applications Ready for Review", total_ready_apps, fill_blue_light),
        ("Applications In Progress (Applying)", sum(c['applying'] for c in company_data.values()), fill_amber),
        ("Applications Needing Answers (Question Gaps)", total_needs_answers, fill_amber),
        ("Applications Already Applied Prior", total_already_applied, fill_kpi_label),
        ("Archived / Superseded Applications", total_archived, fill_kpi_label),
        ("Failed Applications (3 Attempts Exhausted)", total_failed, fill_red),
        ("Zoho Mail Not Connected Failures", total_zoho_not_connected, fill_red if total_zoho_not_connected > 0 else fill_green),
    ]

    ws_sum['B5'] = "Metric KPI"
    ws_sum['C5'] = "Value"
    ws_sum['B5'].font = font_header
    ws_sum['C5'].font = font_header
    ws_sum['B5'].fill = fill_header_navy
    ws_sum['C5'].fill = fill_header_navy
    ws_sum['B5'].alignment = align_left
    ws_sum['C5'].alignment = align_center

    cur_row = 6
    for label, val, val_fill in kpis:
        c1 = ws_sum.cell(row=cur_row, column=2, value=label)
        c2 = ws_sum.cell(row=cur_row, column=3, value=val)
        c1.font = font_bold if "Companies Fully Automated" in label or "Applications Submitted" in label else font_data
        c2.font = font_bold
        c1.border = thin_border
        c2.border = thin_border
        c1.fill = fill_kpi_label
        c2.fill = val_fill
        c1.alignment = align_left
        c2.alignment = align_center
        cur_row += 1

    # ─────────────────────────────────────────────────────────────
    # SHEET 2: ALL COMPANIES BREAKDOWN
    # ─────────────────────────────────────────────────────────────
    ws_comp = wb.create_sheet(title="Company Breakdown")
    ws_comp.views.sheetView[0].showGridLines = True

    comp_headers = [
        "Company Name",
        "Automated End-to-End?",
        "Total Distributed",
        "Submitted",
        "Ready for Review",
        "Applying Now",
        "Needs Answers",
        "Already Applied",
        "Archived",
        "Failed",
        "Zoho Not Connected",
        "Unique Job Links",
        "Candidates Allotted",
        "Success Rate (%)"
    ]

    for col_idx, h in enumerate(comp_headers, 1):
        cell = ws_comp.cell(row=1, column=col_idx, value=h)
        cell.font = font_header
        cell.fill = fill_header_navy
        cell.alignment = align_center
        cell.border = thin_border

    sorted_companies = sorted(
        company_data.values(),
        key=lambda x: (x['submitted'] > 0, x['submitted'], x['total']),
        reverse=True
    )

    r_idx = 2
    for comp in sorted_companies:
        is_automated = "YES (Fully Automated)" if comp['submitted'] > 0 else ("IN PROGRESS" if (comp['ready_for_review'] > 0 or comp['applying'] > 0) else "PENDING")
        total_sub = comp['submitted']
        total_dist = comp['total']
        rate = round((total_sub / total_dist) * 100, 1) if total_dist > 0 else 0.0

        row_vals = [
            comp['name'],
            is_automated,
            total_dist,
            comp['submitted'],
            comp['ready_for_review'],
            comp['applying'],
            comp['needs_answers'],
            comp['already_applied'],
            comp['archived'],
            comp['failed'],
            comp['zoho_not_connected'],
            len(comp['urls']),
            len(comp['candidates']),
            f"{rate}%"
        ]

        for col_idx, val in enumerate(row_vals, 1):
            cell = ws_comp.cell(row=r_idx, column=col_idx, value=val)
            cell.font = font_data
            cell.border = thin_border
            if col_idx == 1:
                cell.alignment = align_left
                cell.font = font_bold
            elif col_idx == 2:
                cell.alignment = align_center
                if "YES" in is_automated:
                    cell.fill = fill_green
                    cell.font = font_bold
                elif "IN PROGRESS" in is_automated:
                    cell.fill = fill_amber
                else:
                    cell.fill = fill_kpi_label
            elif col_idx == 4 and comp['submitted'] > 0:
                cell.alignment = align_center
                cell.fill = fill_green
                cell.font = font_bold
            elif col_idx == 11 and comp['zoho_not_connected'] > 0:
                cell.alignment = align_center
                cell.fill = fill_red
                cell.font = font_bold
            else:
                cell.alignment = align_center

        r_idx += 1

    # ─────────────────────────────────────────────────────────────
    # SHEET 3: ZOHO NOT CONNECTED LOG
    # ─────────────────────────────────────────────────────────────
    ws_zoho = wb.create_sheet(title="Zoho Not Connected Log")
    ws_zoho.views.sheetView[0].showGridLines = True

    zoho_headers = [
        "Candidate AWL ID",
        "Company",
        "Status",
        "Job URL",
        "Error / Diagnostic Message",
        "Created At"
    ]

    for col_idx, h in enumerate(zoho_headers, 1):
        cell = ws_zoho.cell(row=1, column=col_idx, value=h)
        cell.font = font_header
        cell.fill = fill_header_blue
        cell.alignment = align_center
        cell.border = thin_border

    r_idx = 2
    for z in zoho_rows:
        vals = [
            z['awl_id'],
            z['company'],
            z['status'],
            z['job_url'],
            z['error_message'],
            z['created_at']
        ]
        for col_idx, val in enumerate(vals, 1):
            cell = ws_zoho.cell(row=r_idx, column=col_idx, value=val)
            cell.font = font_data
            cell.border = thin_border
            if col_idx in [1, 2, 3]:
                cell.alignment = align_center
            else:
                cell.alignment = align_left
            if col_idx == 3:
                cell.fill = fill_red
        r_idx += 1

    # ─────────────────────────────────────────────────────────────
    # SHEET 4: ALL 950 APPLICATIONS RAW AUDIT
    # ─────────────────────────────────────────────────────────────
    ws_raw = wb.create_sheet(title="All Applications Audit")
    ws_raw.views.sheetView[0].showGridLines = True

    raw_headers = [
        "Record ID",
        "Candidate AWL ID",
        "Company",
        "Job URL",
        "Status",
        "Error / State Message",
        "Created At",
        "Updated At"
    ]

    for col_idx, h in enumerate(raw_headers, 1):
        cell = ws_raw.cell(row=1, column=col_idx, value=h)
        cell.font = font_header
        cell.fill = fill_header_navy
        cell.alignment = align_center
        cell.border = thin_border

    r_idx = 2
    for row in rows:
        norm_key, display_name = normalize_company(row.get('company'), row.get('job_url'))
        vals = [
            row.get('id'),
            row.get('applywizz_id'),
            display_name,
            row.get('job_url'),
            row.get('status'),
            row.get('error_message') or '',
            row.get('created_at'),
            row.get('updated_at')
        ]
        for col_idx, val in enumerate(vals, 1):
            cell = ws_raw.cell(row=r_idx, column=col_idx, value=val)
            cell.font = font_data
            cell.border = thin_border
            if col_idx in [2, 5]:
                cell.alignment = align_center
                if val == 'submitted':
                    cell.fill = fill_green
                elif val == 'failed':
                    cell.fill = fill_red
                elif val == 'ready_for_review':
                    cell.fill = fill_blue_light
            else:
                cell.alignment = align_left
        r_idx += 1

    # Auto-fit column widths across all sheets
    for ws in [ws_sum, ws_comp, ws_zoho, ws_raw]:
        for col in ws.columns:
            max_len = 0
            col_letter = get_column_letter(col[0].column)
            for cell in col:
                val_str = str(cell.value or '')
                if cell.row == 1 or ws == ws_sum:
                    # Don't let big title inflate
                    if len(val_str) > max_len and len(val_str) < 60:
                        max_len = len(val_str)
                else:
                    if len(val_str) > max_len:
                        max_len = min(len(val_str), 55)
            ws.column_dimensions[col_letter].width = max(max_len + 3, 12)

    os.makedirs('Data', exist_ok=True)
    out_xlsx = os.path.abspath('Data/Workday_Company_Automation_Report.xlsx')
    out_csv = os.path.abspath('Data/Workday_Company_Automation_Report.csv')
    
    wb.save(out_xlsx)
    print(f"Successfully saved Excel report to: {out_xlsx}")

    # Also save CSV of Company Breakdown for quick import/terminal viewing
    import csv
    with open(out_csv, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(comp_headers)
        for comp in sorted_companies:
            is_automated = "YES (Fully Automated)" if comp['submitted'] > 0 else ("IN PROGRESS" if (comp['ready_for_review'] > 0 or comp['applying'] > 0) else "PENDING")
            total_sub = comp['submitted']
            total_dist = comp['total']
            rate = round((total_sub / total_dist) * 100, 1) if total_dist > 0 else 0.0
            writer.writerow([
                comp['name'],
                is_automated,
                total_dist,
                comp['submitted'],
                comp['ready_for_review'],
                comp['applying'],
                comp['needs_answers'],
                comp['already_applied'],
                comp['archived'],
                comp['failed'],
                comp['zoho_not_connected'],
                len(comp['urls']),
                len(comp['candidates']),
                f"{rate}%"
            ])
    print(f"Successfully saved CSV report to: {out_csv}")

if __name__ == '__main__':
    generate_report()
