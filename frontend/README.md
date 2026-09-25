# Workday Auto-Apply Frontend Dashboard

A modern, responsive control panel and real-time monitoring interface for the Workday Automated Application Engine.

## Features
- **Live Worker Fleet Tracking**: View real-time active status, memory, current job link, and throughput for Worker 1 to 10.
- **Batch Queue Monitor**: Filter, search, and inspect entries in Supabase `batch_job_queue`.
- **Schema Cache Browser**: Inspect discovered Workday form steps, field types, and question schemas stored in `job_form_schemas`.
- **Candidate Facts Inspector**: Verify normalized candidate facts (DOB MM/DD/YYYY, work authorization, contact details).
- **Live Console**: Real-time event log stream for debugging automation runs.

## Running Locally

From the project root:
```bash
npm run frontend:dev
```

Or directly from the `frontend/` directory:
```bash
cd frontend
npm start
```

Visit [http://localhost:3000](http://localhost:3000) in your browser.
