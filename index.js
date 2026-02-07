	// index.js
	const express = require('express');
	const crypto = require('crypto');
	const cors = require('cors');
	require('dotenv').config();
	const requireAuth = require('./middleware/requireAuth');


	const treeMenuRouter = require('./routes/treeMenu');
	const itemsRouter = require('./routes/items');
	const departmentsRouter = require('./routes/departments');
	const divisionsRouter = require('./routes/divisions');
	const usersRouter = require('./routes/users');
	const userDepartmentsRouter = require('./routes/userDepartments');
	const userDivisionsRouter = require('./routes/userDivisions');
	const divisionDepartmentsRouter = require('./routes/division_departments');
	const authRouter = require('./routes/auth');
	const profileRouter = require('./routes/profile');

	// new routes
	const staffTypesRouter = require('./routes/staffTypes');
	const shiftTypesRouter = require('./routes/shiftTypes');
	const staffShiftRulesRouter = require('./routes/staffShiftRules');
	const userManagersRouter = require('./routes/userManagers');
	const shiftTemplatesRouter = require('./routes/shiftTemplates');
	const shiftTemplateEntriesRouter = require('./routes/shiftTemplateEntries');
	const shiftPeriodsRouter = require('./routes/shiftPeriods');
	const shiftAssignmentsRouter = require('./routes/shiftAssignments');
	const shiftRequestsRouter = require('./routes/shiftRequests');
	const userAbsencesRouter = require('./routes/userAbsences');
	const notifications = require('./routes/notifications');
	const fcm = require('./routes/fcm');
	const { startNotificationDispatcher } = require('./services/notificationDispatcher');
	const shiftOffersRouter = require('./routes/shiftOffers');
	const holidayYearsRouter = require('./routes/holidayYears');
	const yearlyHolidaysRouter = require('./routes/yearlyHolidays');
	const absenceTypesRouter = require('./routes/absenceTypes');


	const colleagueShiftsQuery = require('./query/colleagueShifts');
	const switchCandidatesQuery = require('./query/switchCandidates');
	const availableShiftsQuery = require('./query/availableShifts');
	
	
 // =========================================================
 // DROPDOWNS (read-only) backed by DB views
 // =========================================================
 const dropdownUsersQuery = require('./query/dropdownUsers');
 const dropdownDepartmentsQuery = require('./query/dropdownDepartments');
 const dropdownShiftTypesQuery = require('./query/dropdownShiftTypes');
 const dropdownAbsenceTypesQuery = require('./query/dropdownAbsenceTypes');

	// =========================================================
	// SEARCH (read-only) query endpoints (backed by DB views)
	// =========================================================
	const searchAvailableShiftsQuery = require('./query/searchAvailableShifts');
	const searchAssignedShiftsQuery = require('./query/searchAssignedShifts');
	const searchPendingShiftRequestsQuery = require('./query/searchPendingShiftRequests');
	const searchColleagueShiftsQuery = require('./query/searchColleagueShifts');
	const mobileDashboardQuery = require('./query/mobileDashboard');

	const app = express();
	const port = process.env.API_PORT || 3000;
	const host = process.env.API_HOST || '127.0.0.1';

	+// Behind Nginx (reverse proxy)
app.set('trust proxy', 1);

// CORS (supports production allow-list + always allow localhost dev ports)
const allowedOrigins = (process.env.CORS_ORIGINS || '')
 .split(',')
 .map(s => s.trim())
 .filter(Boolean);

function isAllowedOrigin(origin) {
 if (!origin) return true; // same-origin / curl / server-to-server
 if (allowedOrigins.length === 0) return true; // no allow-list => allow all (testing)
 if (allowedOrigins.includes(origin)) return true;
 // allow Flutter web dev server / local testing
 if (/^http:\/\/localhost:\d+$/.test(origin)) return true;
 if (/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return true;
 return false;
}

app.use(cors({
 origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
 methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
 allowedHeaders: ['Content-Type', 'Authorization'],
}));
	app.use(express.json());
	
	function ts() {
  // ISO 8601, sortable, timezone-safe
  return new Date().toISOString();
}

	
// =========================================================
// 🔍 REQUEST ID + LIFECYCLE LOGGER
// Must be registered BEFORE all route mounts
// =========================================================
app.use((req, res, next) => {
  const rid = crypto.randomBytes(4).toString('hex');
  req.rid = rid;

  const start = Date.now();
 const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`${ts()} [${rid}] --> ${req.method} ${req.originalUrl} ip=${ip}`);
  

  res.on('finish', () => {
    console.log(
      `${ts()} [${rid}] <-- ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`
    );
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(
          `${ts()} [${rid}] xx  ${req.method} ${req.originalUrl} CLOSED ${Date.now() - start}ms`
      );
    }
  });

  next();
});
 
	

// =========================================================
// 🔎 STUCK REQUEST WATCHDOG (temporary diagnostics)
// Logs any request that takes >5s without finishing
// =========================================================
app.use((req, res, next) => {
  const started = Date.now();

  const timer = setTimeout(() => {
    console.error('⚠️ STUCK REQUEST', {
      method: req.method,
      url: req.originalUrl,
      elapsedMs: Date.now() - started,
    });
  }, 5000);

  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));

  next();
});


	app.get('/', (req, res) => {
	  res.json({ message: 'API is working ✅' });
	});

	console.log('strict routing =', app.get('strict routing'));


	app.use('/auth', authRouter);
	
	// Protect EVERYTHING below (all business endpoints)
app.use(requireAuth);
	app.use('/profile', profileRouter);
	app.use('/tree-menu', treeMenuRouter);
	app.use('/items', itemsRouter);
	app.use('/departments', departmentsRouter);
	app.use('/divisions', divisionsRouter);
	app.use('/users', usersRouter);
	app.use('/user-departments', userDepartmentsRouter);
	app.use('/user-divisions', userDivisionsRouter);
	app.use('/division-departments', divisionDepartmentsRouter);

	// new mounts
	app.use('/staff-types', staffTypesRouter);
	app.use('/shift-types', shiftTypesRouter);
	app.use('/staff-shift-rules', staffShiftRulesRouter);
	app.use('/user-managers', userManagersRouter);
	app.use('/shift-templates', shiftTemplatesRouter);
	app.use('/shift-template-entries', shiftTemplateEntriesRouter);
	app.use('/shift-periods', shiftPeriodsRouter);
	app.use('/shift-assignments', shiftAssignmentsRouter);
	app.use('/shift-requests', shiftRequestsRouter);
	app.use('/user-absences', userAbsencesRouter);
	app.use('/shift-offers', shiftOffersRouter);
	app.use('/holiday-years', holidayYearsRouter);
	app.use('/yearly-holidays', yearlyHolidaysRouter);
	app.use('/absence-types', absenceTypesRouter);

	app.use('/colleague-shifts', colleagueShiftsQuery);
	app.use('/switch-candidates', switchCandidatesQuery);
	app.use('/available-shifts', availableShiftsQuery);
	
	
 // =========================================================
 // DROPDOWNS (read-only)
 // =========================================================
 app.use('/dropdown/users', dropdownUsersQuery);
 app.use('/dropdown/departments', dropdownDepartmentsQuery);
 app.use('/dropdown/shift-types', dropdownShiftTypesQuery);
 app.use('/dropdown/absence-types', dropdownAbsenceTypesQuery);


	// =========================================================
	// SEARCH (read-only)
	// =========================================================
	app.use('/search/available-shifts', searchAvailableShiftsQuery);
	app.use('/search/assigned-shifts', searchAssignedShiftsQuery);
	app.use('/search/pending-requests', searchPendingShiftRequestsQuery);
	app.use('/search/colleague-shifts', searchColleagueShiftsQuery);
	app.use('/dashboard/mobile', mobileDashboardQuery);
	
	app.use('/fcm', fcm);
	app.use('/notifications', notifications);

	app.listen(port, host, () => {
	   console.log(`API listening on ${host}:${port}`);
		// ✅ Start push dispatcher once API is up.
	  startNotificationDispatcher().catch((e) => {
		console.error('Failed to start notification dispatcher:', e);
	  });
	});

	module.exports = app;
