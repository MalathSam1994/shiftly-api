// index.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();


const treeMenuRouter = require('./routes/treeMenu');
const itemsRouter = require('./routes/items');
const departmentsRouter = require('./routes/departments');
const divisionsRouter = require('./routes/divisions');
const usersRouter = require('./routes/users');
const userDepartmentsRouter = require('./routes/userDepartments');
const userDivisionsRouter = require('./routes/userDivisions');
const authRouter = require('./routes/auth');

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

const colleagueShiftsQuery = require('./query/colleagueShifts');
const switchCandidatesQuery = require('./query/switchCandidates');

const app = express();
const port = process.env.API_PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'API is working ✅' });
});

console.log('strict routing =', app.get('strict routing'));


app.use('/auth', authRouter);

app.use('/tree-menu', treeMenuRouter);
app.use('/items', itemsRouter);
app.use('/departments', departmentsRouter);
app.use('/divisions', divisionsRouter);
app.use('/users', usersRouter);
app.use('/user-departments', userDepartmentsRouter);
app.use('/user-divisions', userDivisionsRouter);

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
app.use('/notifications', notifications);
app.use('/shift-offers', shiftOffersRouter);

app.use('/colleague-shifts', colleagueShiftsQuery);
app.use('/switch-candidates', switchCandidatesQuery);

app.use('/fcm', fcm);

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
    // ✅ Start push dispatcher once API is up.
  startNotificationDispatcher().catch((e) => {
    console.error('Failed to start notification dispatcher:', e);
  });
});

module.exports = app;
