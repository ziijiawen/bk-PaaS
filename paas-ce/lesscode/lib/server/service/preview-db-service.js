/**
 * Tencent is pleased to support the open source community by making 蓝鲸智云PaaS平台社区版 (BlueKing PaaS Community Edition) available.
 * Copyright (C) 2017-2018 THL A29 Limited, a Tencent company. All rights reserved.
 * Licensed under the MIT License (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://opensource.org/licenses/MIT
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 */

import DBEngineService from './db-engine-service'
import { LCDataService, TABLE_FILE_NAME, getDataService } from './data-service'
import { EntitySchema, createConnection, EventSubscriber } from 'typeorm'
import { RequestContext } from '../middleware/request-context'
import { encrypt, decrypt, uuid } from '../util'
import { NO_LENGTH_ORM_KEY } from '../../shared/data-source'
import { getAllGroupAndFunction } from './function'
const dataBaseConf = require('../conf/data-source')

/**
 * 开启预览
 * @param {*} projectId 项目id
 */
export const enablePerviewDb = async (projectId, dbName) => {
    const dbInfo = {
        projectId,
        dbName,
        userName: uuid(),
        passWord: uuid()
    }

    // 创建用于预览的DB
    const previewDbEngine = await getPreviewDbEngine()
    await previewDbEngine.execCb(async (pool) => {
        // 创建项目对应的预览数据库
        await pool.query(`CREATE DATABASE \`${dbInfo.dbName}\`;`)
        // 创建用户并授权对应的库
        await pool.query(`CREATE USER '${dbInfo.userName}'@'%' IDENTIFIED BY '${dbInfo.passWord}';`)
        await pool.query(`GRANT ALL ON ${dbInfo.dbName}.* TO '${dbInfo.userName}'@'%';`)
        await pool.query('FLUSH PRIVILEGES;')
    })

    // 加密
    dbInfo.userName = encrypt(dbInfo.userName)
    dbInfo.passWord = encrypt(dbInfo.passWord)

    // 写入数据库
    await LCDataService.add(TABLE_FILE_NAME.PREVIEW_DB, dbInfo)
}

/**
 * 获取预览环境下的db配置
 * @param {*} projectId 项目id
 */
export const getPreviewDbConfig = async (projectId = null) => {
    const previewDb = await LCDataService.findOne(TABLE_FILE_NAME.PREVIEW_DB, { projectId, deleteFlag: 0 })
    const config = process.env.NODE_ENV === 'production' ? dataBaseConf.prod : dataBaseConf.dev
    const dbConfig = {
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password
    }
    if (previewDb) {
        Object.assign(dbConfig, {
            user: decrypt(previewDb.userName),
            password: decrypt(previewDb.passWord),
            database: previewDb.dbName
        })
    }
    return dbConfig
}

/**
 * 获取预览环境下的 db，直接操作 mysql
 * @param {*} projectId 项目id
 */
export const getPreviewDbEngine = async (projectId) => {
    const dbConfig = await getPreviewDbConfig(projectId)
    return new DBEngineService(dbConfig)
}

@EventSubscriber()
class PreviewSubscriber {
    beforeInsert ({ entity }) {
        const currentUser = RequestContext.getCurrentUser() || {}
        entity.createUser = currentUser.username || entity.createUser
        entity.updateUser = currentUser.username || entity.updateUser
    }

    beforeUpdate ({ entity }) {
        const currentUser = RequestContext.getCurrentUser() || {}
        entity.updateUser = currentUser.username || entity.updateUser
    }
}

/**
 * 获取预览环境下的 data service
 * 注意：使用完毕后，请在在适合的时机关闭连接（close方法）
 * @param {*} projectId 项目id
 */
export const getPreviewDataService = async (projectId) => {
    const [{ list: tables }, config] = await Promise.all([
        LCDataService.get({
            tableFileName: TABLE_FILE_NAME.DATA_TABLE,
            query: { projectId, deleteFlag: 0 }
        }),
        getPreviewDbConfig(projectId)
    ])

    const { entities, entityMap } = tables.reduce((acc, cur) => {
        const columns = JSON.parse(cur.columns || '[]').reduce((acc, cur) => {
            const { length, ...rest } = cur
            acc[cur.name] = NO_LENGTH_ORM_KEY.includes(cur.type) ? rest : cur
            return acc
        }, {})
        const entity = new EntitySchema({
            name: cur.tableName,
            columns
        })
        acc.entities.push(entity)
        acc.entityMap[cur.tableName] = entity
        return acc
    }, { entities: [], entityMap: {} })
    const ormConfig = {
        name: uuid(),
        type: 'mysql',
        host: config.host,
        port: config.port,
        username: config.user,
        password: config.password,
        database: config.database,
        entities,
        subscribers: [PreviewSubscriber],
        synchronize: false,
        migrationsRun: false,
        extra: {
            connectionLimit: 5
        }
    }
    const con = await createConnection(ormConfig)
    const previewDataService = {
        ...getDataService(ormConfig.name, entityMap),
        close () {
            return new Promise((resolve, reject) => {
                if (con.isConnected) {
                    con.close().then(resolve, reject)
                } else {
                    resolve()
                }
            })
        }
    }
    return previewDataService
}
