import urllib.request
import json
import os

url = 'https://yuppxmwrztbirsnzgfjh.supabase.co'
key = ''
with open('.env', 'r', encoding='utf-8') as f:
    for line in f:
        if line.startswith('SUPABASE_SERVICE_ROLE_KEY='):
            key = line.strip().split('=', 1)[1].strip('"\' ')

headers = {
    'apikey': key,
    'Authorization': f'Bearer {key}',
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
}

shot_url = 'https://yuppxmwrztbirsnzgfjh.supabase.co/storage/v1/object/public/submitted-applications/CLIENT/1792731924887_submitted_1792731924887.png'
dist_id = '645bb943-d3b4-423c-87a0-cdf2f6b56dfa'
task_id = '244e25a0-5347-4889-a63f-53a4d018c7a2'

print(f"Updating job_distributions #{dist_id} and submission_tasks #{task_id} with screenshot: {shot_url}")

# 1. Update job_distributions
jd_payload = json.dumps({
    'status': 'submitted',
    'application_submitted_screenshot_url': shot_url
}).encode('utf-8')
req1 = urllib.request.Request(f'{url}/rest/v1/job_distributions?id=eq.{dist_id}', data=jd_payload, headers=headers, method='PATCH')
try:
    with urllib.request.urlopen(req1) as resp:
        print('✅ job_distributions updated:', resp.read().decode('utf-8'))
except Exception as e:
    print('❌ JD update error:', e)

# 2. Update submission_tasks
st_payload = json.dumps({
    'status': 'submitted',
    'screenshot_path': shot_url,
    'application_submitted_screenshot_url': shot_url
}).encode('utf-8')
req2 = urllib.request.Request(f'{url}/rest/v1/submission_tasks?id=eq.{task_id}', data=st_payload, headers=headers, method='PATCH')
try:
    with urllib.request.urlopen(req2) as resp:
        print('✅ submission_tasks updated:', resp.read().decode('utf-8'))
except Exception as e:
    print('❌ ST update error:', e)
