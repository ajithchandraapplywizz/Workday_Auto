$url = 'https://yuppxmwrztbirsnzgfjh.supabase.co'
$envContent = Get-Content -Path '.env' -Raw
$match = [regex]::Match($envContent, 'SUPABASE_SERVICE_ROLE_KEY=([^\r\n]+)')
$key = $match.Groups[1].Value.Trim().Trim('"').Trim("'")

$headers = @{
    'apikey' = $key
    'Authorization' = "Bearer $key"
    'Content-Type' = 'application/json'
    'Prefer' = 'return=representation'
}

$shotUrl = 'https://yuppxmwrztbirsnzgfjh.supabase.co/storage/v1/object/public/submitted-applications/CLIENT/1792731924887_submitted_1792731924887.png'
$distId = '645bb943-d3b4-423c-87a0-cdf2f6b56dfa'
$taskId = '244e25a0-5347-4889-a63f-53a4d018c7a2'

Write-Host "Updating job_distributions ID: $distId"
$jdBody = @{
    status = 'submitted'
    application_submitted_screenshot_url = $shotUrl
} | ConvertTo-Json

try {
    $jdRes = Invoke-RestMethod -Uri "$url/rest/v1/job_distributions?id=eq.$distId" -Method Patch -Headers $headers -Body $jdBody
    Write-Host "SUCCESS JD:" ($jdRes | ConvertTo-Json -Compress)
} catch {
    Write-Host "ERR JD:" $_.Exception.Message
}

Write-Host "Updating submission_tasks ID: $taskId"
$stBody = @{
    status = 'submitted'
    screenshot_path = $shotUrl
    application_submitted_screenshot_url = $shotUrl
} | ConvertTo-Json

try {
    $stRes = Invoke-RestMethod -Uri "$url/rest/v1/submission_tasks?id=eq.$taskId" -Method Patch -Headers $headers -Body $stBody
    Write-Host "SUCCESS ST:" ($stRes | ConvertTo-Json -Compress)
} catch {
    Write-Host "ERR ST:" $_.Exception.Message
}
