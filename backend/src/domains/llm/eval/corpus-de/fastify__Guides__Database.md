<h1 align="center">Fastify</h1>

## Datenbank

Das Fastify-Ökosystem bietet eine Reihe von
Plugins zur Verbindung mit verschiedenen Datenbankengines.
Dieser Leitfaden behandelt Engines, für die Fastify
Plugins in der Fastify-Organisation gepflegt werden.

> Falls es kein Plugin für Ihre gewünschte Datenbank gibt,
> können Sie die Datenbank trotzdem verwenden, da Fastify datenbankunabhängig ist.
> Durch Befolgen der Beispiele der in diesem Leitfaden aufgeführten Datenbank-Plugins
> kann ein Plugin für die fehlende Datenbankengine geschrieben werden.

> Wenn Sie Ihr eigenes Fastify-Plugin schreiben möchten,
> sehen Sie sich bitte den [Plugins Guide](./Plugins-Guide.md) an.

### [MySQL](https://github.com/fastify/fastify-mysql)

Installieren Sie das Plugin mit `npm i @fastify/mysql`.

*Verwendung:*
```javascript
const fastify = require('fastify')()

fastify.register(require('@fastify/mysql'), {
  connectionString: 'mysql://root@localhost/mysql'
})

fastify.get('/user/:id', function(req, reply) {
  fastify.mysql.query(
    'SELECT id, username, hash, salt FROM users WHERE id=?', [req.params.id],
    function onResult (err, result) {
      reply.send(err || result)
    }
  )
})

fastify.listen({ port: 3000 }, err => {
  if (err) throw err
  console.log(`server listening on ${fastify.server.address().port}`)
})
```
### [Postgres](https://github.com/fastify/fastify-postgres)
Installiere das Plugin mit `npm i pg @fastify/postgres`.

*Beispiel*:
```javascript
const fastify = require('fastify')()

fastify.register(require('@fastify/postgres'), {
  connectionString: 'postgres://postgres@localhost/postgres'
})

fastify.get('/user/:id', function (req, reply) {
  fastify.pg.query(
    'SELECT id, username, hash, salt FROM users WHERE id=$1', [req.params.id],
    function onResult (err, result) {
      reply.send(err || result)
    }
  )
})

fastify.listen({ port: 3000 }, err => {
  if (err) throw err
  console.log(`server listening on ${fastify.server.address().port}`)
})
```
### [Redis](https://github.com/fastify/fastify-redis)
Installiere das Plugin mit `npm i @fastify/redis`

*Verwendung:*
```javascript
'use strict'

const fastify = require('fastify')()

fastify.register(require('@fastify/redis'), { host: '127.0.0.1' })
// or
fastify.register(require('@fastify/redis'), { url: 'redis://127.0.0.1', /* other redis options */ })

fastify.get('/foo', function (req, reply) {
  const { redis } = fastify
  redis.get(req.query.key, (err, val) => {
    reply.send(err || val)
  })
})

fastify.post('/foo', function (req, reply) {
  const { redis } = fastify
  redis.set(req.body.key, req.body.value, (err) => {
    reply.send(err || { status: 'ok' })
  })
})

fastify.listen({ port: 3000 }, err => {
  if (err) throw err
  console.log(`server listening on ${fastify.server.address().port}`)
})
```
Standardmäßig schließt `@fastify/redis` die Client-Verbindung nicht, wenn der Fastify-Server herunterfährt.
Um dieses Verhalten zu aktivieren, registrieren Sie den Client wie folgt:
```javascript
fastify.register(require('@fastify/redis'), {
  client: redis,
  closeClient: true
})
```
### [Mongo](https://github.com/fastify/fastify-mongodb)
Installieren Sie das Plugin mit `npm i @fastify/mongodb`

*Verwendung:*
```javascript
const fastify = require('fastify')()

fastify.register(require('@fastify/mongodb'), {
  // force to close the mongodb connection when app stopped
  // the default value is false
  forceClose: true,

  url: 'mongodb://mongo/mydb'
})

fastify.get('/user/:id', async function (req, reply) {
  // Or this.mongo.client.db('mydb').collection('users')
  const users = this.mongo.db.collection('users')

  // if the id is an ObjectId format, you need to create a new ObjectId
  const id = this.mongo.ObjectId(req.params.id)
  try {
    const user = await users.findOne({ id })
    return user
  } catch (err) {
    return err
  }
})

fastify.listen({ port: 3000 }, err => {
  if (err) throw err
})
```
### Plugin für eine Datenbankbibliothek schreiben
Wir könnten auch ein Plugin für eine Datenbankbibliothek schreiben (z. B. Knex, Prisma oder TypeORM).
Für unser Beispiel verwenden wir [Knex](https://knexjs.org/).
```javascript
'use strict'

const fp = require('fastify-plugin')
const knex = require('knex')

function knexPlugin(fastify, options, done) {
  if(!fastify.knex) {
    const knex = knex(options)
    fastify.decorate('knex', knex)

    fastify.addHook('onClose', (fastify, done) => {
      if (fastify.knex === knex) {
        fastify.knex.destroy(done)
      }
    })
  }

  done()
}

export default fp(knexPlugin, { name: 'fastify-knex-example' })
```
### Ein Plugin für eine Datenbank-Engine schreiben

In diesem Beispiel erstellen wir ein einfaches Fastify MySQL Plugin von Grund auf (es handelt sich um ein stark vereinfachtes Beispiel, verwenden Sie bitte in der Produktion das offizielle Plugin).
```javascript
const fp = require('fastify-plugin')
const mysql = require('mysql2/promise')

function fastifyMysql(fastify, options, done) {
  const connection = mysql.createConnection(options)

  if (!fastify.mysql) {
    fastify.decorate('mysql', connection)
  }

  fastify.addHook('onClose', (fastify, done) => connection.end().then(done).catch(done))

  done()
}

export default fp(fastifyMysql, { name: 'fastify-mysql-example' })
```
### Migrationen

Datenbankschema-Migrationen sind ein integraler Bestandteil des Datenbankmanagements und der Entwicklung. Migrationen bieten eine wiederholbare und testbare Möglichkeit, das Schema einer Datenbank zu ändern und Datenverlust zu verhindern.

Wie am Anfang des Leitfadens erwähnt, ist Fastify datenbankunabhängig und kann daher jedes Node.js-Datenbankmigrationstool verwendet werden. Wir zeigen ein Beispiel für die Verwendung von [Postgrator](https://www.npmjs.com/package/postgrator), das Unterstützung für Postgres, MySQL, SQL Server und SQLite bietet. Für MongoDB-Migrationen siehe [migrate-mongo](https://www.npmjs.com/package/migrate-mongo).

#### [Postgrator](https://www.npmjs.com/package/postgrator)

Postgrator ist ein Node.js SQL-Migrationstool, das einen Ordner mit SQL-Skripten verwendet, um das Datenbankschema zu ändern. Jede Datei im Migrationsordner muss dem Muster folgen: `[version].[action].[optional-description].sql`.

**version:** muss eine aufsteigende Zahl sein (z. B. `001` oder ein Zeitstempel).

**action:** sollte `do` oder `undo` sein. `do` implementiert die Version, `undo` kehrt sie um. Denken Sie dabei an `up` und `down` in anderen Migrationstools.

**optional-description** beschreibt, welche Änderungen die Migration vornimmt. Obwohl optional, sollte sie für alle Migrationen verwendet werden, da dies allen hilft zu wissen, welche Änderungen in einer Migration vorgenommen wurden.

In unserem Beispiel erstellen wir eine einzelne Migration, die eine `users`-Tabelle erstellt, und verwenden `Postgrator`, um diese Migration auszuführen.

> Führen Sie `npm i pg postgrator` aus, um die für das Beispiel benötigten Abhängigkeiten zu installieren.
```sql
// 001.do.create-users-table.sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY NOT NULL,
  created_at DATE NOT NULL DEFAULT CURRENT_DATE,
  firstName TEXT NOT NULL,
  lastName TEXT NOT NULL
);
```
```javascript
const pg = require('pg')
const Postgrator = require('postgrator')
const path = require('node:path')

async function migrate() {
  const client = new pg.Client({
    host: 'localhost',
    port: 5432,
    database: 'example',
    user: 'example',
    password: 'example',
  });

  try {
    await client.connect();

    const postgrator = new Postgrator({
      migrationPattern: path.join(__dirname, '/migrations/*'),
      driver: 'pg',
      database: 'example',
      schemaTable: 'migrations',
      currentSchema: 'public', // Postgres and MS SQL Server only
      execQuery: (query) => client.query(query),
    });

    const result = await postgrator.migrate()

    if (result.length === 0) {
      console.log(
        'No migrations run for schema "public". Already at the latest one.'
      )
    }

    console.log('Migration done.')

    process.exitCode = 0
  } catch(err) {
    console.error(err)
    process.exitCode = 1
  }

  await client.end()
}

migrate()
```
