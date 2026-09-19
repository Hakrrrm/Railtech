param(
  [string]$ProjectRef = 'lswlobnbndcrwzwzjgkb',
  [string]$Origins = 'http://localhost:5173,http://127.0.0.1:5173,https://railtech-repidtransit.vercel.app',
  [switch]$AllowDemo
)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Push-Location $projectDirectory
try {
  & npx supabase@latest link --project-ref $ProjectRef
  if ($LASTEXITCODE) { throw 'Supabase link failed.' }
  & npx supabase@latest db push --linked
  if ($LASTEXITCODE) { throw 'Database migration failed.' }
  $demoEnabled = $AllowDemo.IsPresent.ToString().ToLowerInvariant()
  & npx supabase@latest secrets set 'OPENAI_MAINTENANCE_MODEL=gpt-4.1-mini' "MAINTENANCE_ASSISTANT_ALLOW_DEMO=$demoEnabled" "MAINTENANCE_ASSISTANT_ORIGINS=$Origins" --project-ref $ProjectRef
  if ($LASTEXITCODE) { throw 'Assistant configuration failed.' }
  & npx supabase@latest functions deploy maintenance-assistant --project-ref $ProjectRef --use-api
  if ($LASTEXITCODE) { throw 'Assistant deployment failed.' }
  Write-Host 'Maintenance assistant deployed. The existing server OPENAI_API_KEY is used; OCR configuration is unchanged.'
} finally { Pop-Location }
