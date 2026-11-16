// power-luna plugin(D6 再裁 2026-11-07;ADR 0002)。
//
// power-luna 的载体:插件 = 唯一部署工件,装在全局(所有工作区可用)。
// 注册三件:
//   * skill「agent-creator」——岗位工厂流程知识(skills/agent-creator.md)内置注册,
//     autoinvoke 关死:AI 不得自行认领,仅用户点名或 /agent-creator 命令才加载。
//   * skill「worker(岗位工人)」——工人契约(skills/worker.md,005 工人回路):
//     岗位工厂 spawn 工人会话时点名载入,autoinvoke 关死,不接用户直接唤起。
//   * 命令「/agent-creator」——默认入口;execute 把 prompt 翻成明确指令
//     注入会话(实质仍走 skill 全流程,零逻辑重复)。
//
// 域(D2 改判 2026-11-07):编制落**调用方工作区**的 .opencode/(一个工作区一套独立);
// 本插件与 org.mjs 工具位(power-luna 仓库)只是壳与工具,不持有编制。
// 不动的部分:org.mjs、表单页回路、文件工单润色回路。Triggers 已裁砍;
// 统计 / TUI 面板留远期另议。
//
// 安装(房规 0029:config 路径只放安装件,源码在仓库;注意尾部 \* ——
// 目标目录已存在时,不带 \* 会把源目录整个塞进目标里成 plugins\power-luna\power-luna):
//   Copy-Item -Recurse -Force src\plugins\power-luna\* `
//     $env:USERPROFILE\.config\opencode\plugins\power-luna
// (改名重装前先删旧目录 plugins\agent-creator,避免双重加载)
// 配置目录 plugins/ 下的插件包目录会被自动发现加载。
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Plugin, Skill } from '@opencode/plugin'

const root = dirname(fileURLToPath(import.meta.url))

const COMMAND_PROMPT_PREFIX = '用 skill 工具加载 agent-creator skill,按其流程处理:'
const DEFAULT_TASK = '本次请求(未给参数时,默认按新建岗位流程走表单页回路)。'

export default Plugin.define({
  id: 'power-luna',
  async setup(ctx) {
    const skillPath = join(root, 'skills', 'agent-creator.md')
    const content = await readFile(skillPath, 'utf8')
    // 工人契约(005 工人回路):岗位工厂 spawn 专属工人会话时点名载入;
    // 精益技能 = 读单 → 通读轮次 → 润色/分析纪律 → review-answer 回传 → 停。
    const workerSkillPath = join(root, 'skills', 'worker.md')
    const workerContent = await readFile(workerSkillPath, 'utf8')

    await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make('agent-creator'),
        name: Skill.Name.make('Agent Creator'),
        description:
          'power-luna 岗位工厂——造岗 / 改岗 / 撤岗。仅用户主动唤起:斜杠命令 /agent-creator(默认入口)或点名 skill;AI 不得自行认领。',
        path: Skill.Info.fields.path.make(skillPath),
        content,
      })
      editor.add({
        id: Skill.ID.make('worker'),
        name: Skill.Name.make('岗位工人'),
        description:
          'power-luna 岗位工厂工人契约:读单 → 通读全部轮次 → 按纪律处理 → review-answer 回传交卷 → 停。由岗位工厂 spawn 工人会话时点名载入,不接用户直接唤起。',
        path: Skill.Info.fields.path.make(workerSkillPath),
        content: workerContent,
      })
      editor.update('agent-creator', (skill) => {
        skill.autoinvoke = false
      })
      editor.update('worker', (skill) => {
        skill.autoinvoke = false
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'agent-creator',
        description: 'power-luna 岗位工厂——造岗 / 改岗 / 撤岗(表单页回路)',
        execute: async ({ sessionID, prompt, delivery }) => {
          const args = (prompt?.text ?? '').trim()
          const text = args ? `${COMMAND_PROMPT_PREFIX}${args}` : `${COMMAND_PROMPT_PREFIX}${DEFAULT_TASK}`
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
        },
      })
    })
  },
})
