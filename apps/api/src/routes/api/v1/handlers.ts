import os from 'node:os';
import osu from 'node-os-utils';
import axios from 'axios';
import compare from 'compare-versions';
import cuid from 'cuid';
import bcrypt from 'bcryptjs';
import { asyncExecShell, asyncSleep, cleanupDockerStorage, errorHandler, isDev, listSettings, prisma, uniqueName, version } from '../../../lib/common';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Login, Update } from '.';
import type { GetCurrentUser } from './types';

export async function hashPassword(password: string): Promise<string> {
	const saltRounds = 15;
	return bcrypt.hash(password, saltRounds);
}

export async function cleanupManually() {
	try {
		const destination = await prisma.destinationDocker.findFirst({ where: { engine: '/var/run/docker.sock' } })
		await cleanupDockerStorage(destination.id, true, true)
		return {}
	} catch ({ status, message }) {
		return errorHandler({ status, message })
	}
}
export async function checkUpdate(request: FastifyRequest) {
	try {
		const isStaging = request.hostname === 'staging.coolify.io'
		const currentVersion = version;
		const { data: versions } = await axios.get(
			`https://get.coollabs.io/versions.json?appId=${process.env['COOLIFY_APP_ID']}&version=${currentVersion}`
		);
		const latestVersion = versions['coolify'].main.version
		const isUpdateAvailable = compare(latestVersion, currentVersion);
		if (isStaging) {
			return {
				isUpdateAvailable: true,
				latestVersion: 'next'
			}
		}
		return {
			isUpdateAvailable: isStaging ? true : isUpdateAvailable === 1,
			latestVersion
		};
	} catch ({ status, message }) {
		return errorHandler({ status, message })
	}
}

export async function update(request: FastifyRequest<Update>) {
	const { latestVersion } = request.body;
	try {
		if (!isDev) {
			const { isAutoUpdateEnabled } = (await prisma.setting.findFirst()) || {
				isAutoUpdateEnabled: false
			};
			await asyncExecShell(`docker pull coollabsio/coolify:${latestVersion}`);
			await asyncExecShell(`env | grep COOLIFY > .env`);
			await asyncExecShell(
				`sed -i '/COOLIFY_AUTO_UPDATE=/cCOOLIFY_AUTO_UPDATE=${isAutoUpdateEnabled}' .env`
			);
			await asyncExecShell(
				`docker run --rm -tid --env-file .env -v /var/run/docker.sock:/var/run/docker.sock -v coolify-db coollabsio/coolify:${latestVersion} /bin/sh -c "env | grep COOLIFY > .env && echo 'TAG=${latestVersion}' >> .env && docker stop -t 0 coolify && docker rm coolify && docker compose up -d --force-recreate"`
			);
			return {};
		} else {
			console.log(latestVersion);
			await asyncSleep(2000);
			return {};
		}
	} catch ({ status, message }) {
		return errorHandler({ status, message })
	}
}
export async function restartCoolify(request: FastifyRequest<any>) {
	try {
		const teamId = request.user.teamId;
		if (teamId === '0') {
			if (!isDev) {
				await asyncExecShell(`docker restart coolify`);
				return {};
			} else {
				console.log('Restarting Coolify')
				return {};
			}
		}
		throw { status: 500, message: 'You are not authorized to restart Coolify.' };
	} catch ({ status, message }) {
		return errorHandler({ status, message })
	}
}
export async function showUsage() {
	try {
		return {
			usage: {
				uptime: os.uptime(),
				memory: await osu.mem.info(),
				cpu: {
					load: os.loadavg(),
					usage: await osu.cpu.usage(),
					count: os.cpus().length
				},
				disk: await osu.drive.info('/')
			}

		};
	} catch ({ status, message }) {
		return errorHandler({ status, message })
	}
}
export async function showDashboard(request: FastifyRequest) {
	try {
		const userId = request.user.userId;
		const teamId = request.user.teamId;
		const applications = await prisma.application.findMany({
			where: { teams: { some: { id: teamId === '0' ? undefined : teamId } } },
			include: { settings: true }
		});
		const databases = await prisma.database.findMany({
			where: { teams: { some: { id: teamId === '0' ? undefined : teamId } } }
		});
		const services = await prisma.service.findMany({
			where: { teams: { some: { id: teamId === '0' ? undefined : teamId } } }
		});
		const settings = await listSettings();
		return {
			applications,
			databases,
			services,
			settings,
		};
	} catch ({ status, message }) {
		return errorHandler({ status, message })
	}
}

export async function login(request: FastifyRequest<Login>, reply: FastifyReply) {
	if (request.user) {
		return reply.redirect('/dashboard');
	} else {
		const { email, password, isLogin } = request.body || {};
		if (!email || !password) {
			throw { status: 500, message: 'Email and password are required.' };
		}
		const users = await prisma.user.count();
		const userFound = await prisma.user.findUnique({
			where: { email },
			include: { teams: true, permission: true },
			rejectOnNotFound: false
		});
		if (!userFound && isLogin) {
			throw { status: 500, message: 'User not found.' };
		}
		const { isRegistrationEnabled, id } = await prisma.setting.findFirst()
		let uid = cuid();
		let permission = 'read';
		let isAdmin = false;

		if (users === 0) {
			await prisma.setting.update({ where: { id }, data: { isRegistrationEnabled: false } });
			uid = '0';
		}
		if (userFound) {
			if (userFound.type === 'email') {
				if (userFound.password === 'RESETME') {
					const hashedPassword = await hashPassword(password);
					if (userFound.updatedAt < new Date(Date.now() - 1000 * 60 * 10)) {
						if (userFound.id === '0') {
							await prisma.user.update({
								where: { email: userFound.email },
								data: { password: 'RESETME' }
							});
						} else {
							await prisma.user.update({
								where: { email: userFound.email },
								data: { password: 'RESETTIMEOUT' }
							});
						}

						throw {
							status: 500,
							message: 'Password reset link has expired. Please request a new one.'
						};
					} else {
						await prisma.user.update({
							where: { email: userFound.email },
							data: { password: hashedPassword }
						});
						return {
							userId: userFound.id,
							teamId: userFound.id,
							permission: userFound.permission,
							isAdmin: true
						};
					}
				}

				const passwordMatch = await bcrypt.compare(password, userFound.password);
				if (!passwordMatch) {
					throw {
						status: 500,
						message: 'Wrong password or email address.'
					};
				}
				uid = userFound.id;
				isAdmin = true;
			}
		} else {
			permission = 'owner';
			isAdmin = true;
			if (!isRegistrationEnabled) {
				throw {
					status: 404,
					message: 'Registration disabled by administrator.'
				};
			}
			const hashedPassword = await hashPassword(password);
			if (users === 0) {
				await prisma.user.create({
					data: {
						id: uid,
						email,
						password: hashedPassword,
						type: 'email',
						teams: {
							create: {
								id: uid,
								name: uniqueName(),
								destinationDocker: { connect: { network: 'coolify' } }
							}
						},
						permission: { create: { teamId: uid, permission: 'owner' } }
					},
					include: { teams: true }
				});
			} else {
				await prisma.user.create({
					data: {
						id: uid,
						email,
						password: hashedPassword,
						type: 'email',
						teams: {
							create: {
								id: uid,
								name: uniqueName()
							}
						},
						permission: { create: { teamId: uid, permission: 'owner' } }
					},
					include: { teams: true }
				});
			}
		}
		return {
			userId: uid,
			teamId: uid,
			permission,
			isAdmin
		};
	}
}

export async function getCurrentUser(request: FastifyRequest<GetCurrentUser>, fastify) {
	let token = null
	const { teamId } = request.query
	try {
		const user = await prisma.user.findUnique({
			where: { id: request.user.userId }
		})
		if (!user) {
			throw "User not found";
		}
	} catch (error) {
		throw { status: 401, message: error };
	}
	if (teamId) {
		try {
			const user = await prisma.user.findFirst({
				where: { id: request.user.userId, teams: { some: { id: teamId } } },
				include: { teams: true, permission: true }
			})
			if (user) {
				const permission = user.permission.find(p => p.teamId === teamId).permission
				const payload = {
					...request.user,
					teamId,
					permission: permission || null,
					isAdmin: permission === 'owner' || permission === 'admin'

				}
				token = fastify.jwt.sign(payload)
			}

		} catch (error) {
			// No new token -> not switching teams
		}
	}
	return {
		settings: await prisma.setting.findFirst(),
		token,
		...request.user
	}
}
