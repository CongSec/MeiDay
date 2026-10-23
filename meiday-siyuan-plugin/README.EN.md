![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002173954-hukfm5q.png)

## Preface

**Why build another task diary tool?**

Because current task management software either has an inconvenient reminder channel, or does not support buyout/self-hosting, or your data is not in your own hands  
So, I made MeiDay, open-sourced it, made it self-hostable, and added GitHub/Gitee, documentation, and deployment tutorials  
It is a bit different from products on the market. Current software has too many features, which instead becomes a burden.

MeiDay focuses on the "present"—doing only one thing well: **stable, smooth, and secure task diary recording**.

No feature stacking, only the purest smooth experience.

> **Web experience address:**  https://task.congsec.cn
>
> **Experience test account (read-only):**  congsec/1234578  
> **Stress test account (read-only):**  test/12345678
>
> OSS AccessKey:LTAI5t88s2Wq3vrhS71vKru2  
> OSS SecretKey:JfkgheFQRRN7InfV4wR0rZY3NqdLIy  
> OSS Bucket name:congsec2  
> OSS Endpoint:oss-cn-shenzhen.aliyuncs.com

## Features

### Time Capsule

Completed tasks are automatically sealed into the "Time Capsule", letting you look back at each day's achievements like flipping through a calendar. Supports **calendar view** (completed/uncompleted tasks attributed by day, cross-day task bars visualized), **annual heatmap**, and **workload trend chart**, making your growth trajectory clear at a glance; recurring tasks automatically enumerate all occurrence dates, so reviews miss nothing.

![PixPin_2026-10-02_15-54-38](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/PixPin_2026-10-02_15-54-38-20261002171405-rb81p01.gif)

### Data Security and Performance Security

Tasks and diaries are encrypted and stored directly in your own OSS; the server stores no data; the **frontend** is in the storage bucket, attackers have no way to modify it, eliminating the possibility of js being tampered with to change passwords; even if the **backend** is compromised, it can only see ciphertext and hashes, account passwords are not uploaded to the server and cannot be decrypted; OSS objects are isolated by `users/<username>/`, deleted items first go to the Time Capsule and are not automatically cleaned up.

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260829024746-zi5zb1e.png)

**Large Data Optimization: Ten Years of Data Won't Lag**

Prioritize local cache and 304 conditional requests; today page loads in batches concurrently, Time Capsule loads on demand; merge conflicts on refresh

Performance stress test (test/12345678), simulating ten years of data, 150 tasks per day, still runs smoothly

![recording](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/recording-20260917221055-9cl9zh6.gif)

### Task Adding and Editing

Minimal and smooth add/edit experience, supports batch import of tasks, drag-and-drop task sorting, project group management, recurring tasks and reminder times can be set easily, recurring tasks on specified dates automatically trigger WeChat reminders at the scheduled time, supports drag-and-drop or paste to add attachments

![PixPin_2026-10-02_14-38-45](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/PixPin_2026-10-02_14-38-45-20261002144006-u36ynpm.gif)

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260828223209-7u7yxag.png)

### Multi-device Real-time Sync

Web (https://task.congsec.cn), Android App, SiYuan Note plugin, and Windows desktop widget share the same cloud data, **no local data, second-level sync**, changes on any end update immediately on other ends.

<video controls="controls" src="https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/bandicam_2026-10-02_15-23-55-198-20261002152929-ocgcdov.mp4"></video>

**SiYuan Note Plugin**

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002153104-tpborni.png)

**windows desktop end**

Windows desktop can pin today's unfinished tasks on top, automatically hide during screenshots or video meetings to prevent leaks; supports mouse click-through and transparency adjustment, without blocking screen content.

![6fd63525b500b537f41ec96321e58cf7](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/6fd63525b500b537f41ec96321e58cf7-20261002153012-l9bepb2.jpg)

**APP End**

Supports displaying today's tasks on the app and notification bar, supports widgets

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002145208-d7etu03.png)

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002153206-5r8r5l4.png)

**Web End**

Supports login and display on the Web, convenient for viewing anytime in a browser

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20261002153222-erulnmb.png)

### Private Diary System

Diary data is **stored encrypted** in your OSS, the server stores no data or account passwords; supports encrypted backup import/export, and diaries can be deleted separately to save storage costs.

![PixPin_2026-10-02_17-24-28](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/PixPin_2026-10-02_17-24-28-20261002172506-xjukbo6.gif)

### WeChat/Email Reminders

Task reminders support WeChat and email backend reminders, so check-ins are not missed. Account anomalies—remote login, keys being exposed, configuration being changed, password brute force—trigger second-level WeChat/email alerts.

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260825234846-wfw4afb.png)

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260823015710-9mkeu8w.png)

### Detailed Operation Logs

Displays keys, login records, and every add/delete/modify operation with full traces, key operations are verifiable, and any movement is under control.

![PixPin_2026-10-01_23-23-02](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/PixPin_2026-10-01_23-23-02-20261001232330-fisegvg.gif)

### Data Migration and Backup

All data is in OSS, can be **packaged and migrated as a whole** to change environments; private diaries and Time Capsule support **categorized import/export**, flexible backup, migration on demand, combined with OSS automatic backup, data will never be lost.

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260828222815-q3zqnh2.png)

![image](https://b3logfile.com/file/2026/10/siyuan/1714493573033/assets/image-20260828222817-50vouem.png)

## Self-hosting Tutorial

### Prerequisites

- Node.js 20+
- Python 3.10+
- Alibaba Cloud OSS account and AccessKey
- QQ email or other SMTP service

### Backend

windows

```python
cd backend
# Create virtual environment
python -m venv .venv
# Activate virtual environment
.venv\Scripts\activate
# Install dependencies
pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-proxy-headers
```

Linux:

```python
cd backend
# Create virtual environment
python3 -m venv .venv
# Activate virtual environment
source .venv/bin/activate
# Install dependencies
pip install -r requirements.txt
# Run in background
nohup .venv/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-proxy-headers > backend.log 2>&1 &
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install
# Start frontend, if using Web, please use npm run build:web
npm run dev
```

### CDN Setup Tutorial

#### Binding CDN to Storage Bucket

For bucket creation, please refer to the above tutorial (remember to set the bucket to public, and set CORS to your access domain, **other CORS fields are the same as above**)

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825075856-wju0c4x.png)

After creating the bucket, create a CDN domain and bind it to the bucket. Here we use test as an example.

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825075037-xeyekbr.png)

Bind the storage bucket, then click Next, verify identity through domain resolution.

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825075049-izfqr13.png)

#### Build Frontend Artifacts

Create a new file in the frontend folder, `vi .env.web`, fill in as follows

```python
VITE_API_BASE_URL=
# Fill in your own frontend CDN-accelerated OSS below
VITE_CDN_BASE=https://static.congsec.cn
```

Then use the `npm run build:web` command to build frontend artifacts

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825074040-s1glnfw.png)

Upload the assert folder and logo.png to the storage bucket

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825074328-e2u7nnl.png)

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825074322-gcshks6.png)

#### Verification

`cat frontend/index.html`, if the CDN domain exists, the build is successful

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260825074444-n6d8agu.png)

Access the corresponding js; if it can be accessed successfully, the upload acceleration is successful, then you can visit your website to try it

If the website interface returns blank, it may be a CORS issue, or it may be a CDN cache issue, so refresh the CDN cache and wait a few minutes before accessing again

### APP Build Tutorial

Create a `.env.production` file in the frontend folder: fill in as follows

```python
VITE_CDN_BASE=
VITE_API_BASE_URL=https://task.congsec.cn
```

Run directly: `npm install` and `npm run apk:debug`

After success, the apk file will be output in frontend\android\app\build\outputs\apk\debug

### Desktop Widget Build Tutorial

Just run `python ` with one click

### SiYuan Plugin Build Tutorial

Clone the project [https://github.com/CongSec/MeiDay](https://github.com/CongSec/MeiDay), and in the `frontend` folder run `npm install` and `npm run build:plugin`

Clone the project [https://github.com/CongSec/meiday-siyuan-plugin](https://github.com/CongSec/meiday-siyuan-plugin)

![image](https://b3logfile.com/file/2026/08/siyuan/1714493573033/assets/image-20260828201841-obn97ww.png)

Then build the following content and copy it into the corresponding files

```python
# ① Copy the artifact from the first step into the shell
Copy-Item ".\frontend\dist-plugin\index.html" `
          ".\meiday-siyuan-plugin\src\assets\app.html" -Force

# ② Build the shell (plugin folder)
cd .\meiday-siyuan-plugin
npm install
npm run build

# ③ Copy into the SiYuan Note plugin folder
Copy-Item ".\meiday-siyuan-plugin\dist\*" `
          "D:\desktop\congsectest\data\plugins\meiday-siyuan-plugin\" -Recurse -Force

# ④ Completely exit SiYuan and open again ← must restart, SiYuan does not hot reload
```