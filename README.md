# Space Engine (Web)

在浏览器里探索整个宇宙，风格参考 [SpaceEngine](https://spaceengine.org)。无需安装，所有内容都在 WebGL2 里实时渲染。

- **太阳系**：按你屏幕上显示的日期运行真实星历（JPL 轨道根数、Meeus 月球理论、IAU 自转），昼夜线、月相、日月食都和现实一致。地球、月球、火星等用 NASA / USGS 的真实贴图和高程，近看有程序生成的细节，可以降落。
- **大气与光照**：按物理比例的大气散射（瑞利、米氏、臭氧），从地面看有日落、黄昏蓝调、气辉、星光闪烁和地平线消光。还有日食月食的本影半影、地照、土星环反光、极光和 SpaceEngine 风格的镜头光晕。
- **银河系**：程序生成的 3D 模型，从太阳附近看和 NASA 巡天照片对得上；尘埃固定在空间里，从里到外都是同一个物体。设置里可以切换成 NASA 照片对比。
- **整个宇宙**：按种子确定性生成，包括星系团、星系群、纤维结构和空洞，几万个星系都可以点选、搜索、飞过去。另有真实的本星系群和梅西耶星系。
- **星云和黑洞**：21 个真实星云（猎户、鹰状、玫瑰、马头等）是可以飞进去的体积渲染。黑洞有引力透镜和吸积盘，包括人马座 A\*、M87\*、天鹅座 X-1 和每个星系中心的黑洞。

## 快速开始

需要 Node.js 20 及以上版本，以及支持 WebGL2 的浏览器（推荐 Chrome 或 Edge）。

```sh
git clone https://github.com/SnowingFox/space-engine.git
cd space-engine
npm install
npm run dev        # 打开 http://localhost:5173
```

打包：`npm run build` 会先做类型检查，产物输出到 `dist/`；`npm run preview` 可以本地预览打包结果。

**背景音乐（可选）**：按 F4 打开设置，在里面选一个本地音频文件，或者直接拖到窗口上；也可以把文件放在 `public/music/soundtrack.mp3`。这个目录不会被提交，打包时也会被排除。按 M 开关音乐。

## 怎么玩

开局在地球附近。按 F1 可以随时查看全部按键。

| 按键 | 作用 |
|---|---|
| W / S、A / D、R / F | 前后、左右、上下 |
| Q / E | 翻滚 |
| 滚轮 或 + / − | 调速度（按住 Shift 时 ×10） |
| Z / X | 急停 |
| 左键拖动 | 环顾四周 |
| 右键拖动 | 绕选中的天体转 |
| 单击 | 选中天体 |
| 双击 或 G | 飞过去 |
| Shift+G | 降落 |
| 右键单击 | 天体菜单（选中、前往、降落、居中、跟踪、跟随、信息） |
| C | 居中选中天体 |
| T | 跟踪选中天体（保持居中） |
| Shift+F | 跟随选中天体移动 |
| H | 回地球 |
| Esc | 取消 |
| 空格 | 暂停时间 |
| L / K | 时间加快 / 减慢 10 倍 |
| J | 时间倒流 |
| \\ | 恢复实时 |
| F2 | 太阳系浏览器 |
| F3 | 搜索（恒星、行星、星系、星云、黑洞，可以按名字或 M / NGC / PGC 编号） |
| F4 | 设置 |
| F6 | 风景点 |
| I | 完整天体信息 |
| Shift+L | 标签 |
| O | 轨道 |
| \` 或 F10 | 隐藏界面 |

**一些可以去的地方**：
- 猎户座星云（F3 搜 "Orion"）
- 人马座 A\*（"Sgr A"）
- 仙女座星系（"Andromeda"）
- 土星环
- 地球夜面的城市灯光
- 2024-04-08 的日全食：在控制台运行 `se.date('2024-04-08T18:17Z')`

调试接口在浏览器控制台的 `se` 对象上，例如 `se.galaxy('M51')` 会返回 M51，再用 `se.go(...)` 飞过去。

## 项目结构

```
src/
  main.ts          帧循环、输入、选择、存档（刷新后保留位置）
  core/            单位、随机数
  universe/        数据与模拟：星历(ephemeris)、太阳系(sol)、生成的恒星系(system)、
                   恒星分区(galaxy)、星系与宇宙生成(universe, cosmos)、星云、黑洞
  render/          渲染：管线与曝光(pipeline)、星系(galaxyHost/galaxyShader)、星空(starfield)、
                   行星/地形/大气(planet*, terrain*, atmosphere*)、光照(lighting, star)、星云、黑洞透镜
  game/            HUD、对话框、标签、飞行与自动驾驶(player)、风景点
public/textures/   处理好的贴图（已提交，可直接使用）及来源说明 CREDITS.md
scripts/           截图与性能、运动测量工具（puppeteer），textures/ 下是贴图转换脚本
```

### 原始素材 `assets-src/`（Git LFS）

运行游戏只需要 `public/textures/` 里已经处理好的贴图，它们是普通文件，clone 下来就有。`assets-src/` 里是生成这些贴图用的原始下载，只有想重新生成贴图时才用得到。它通过 [Git LFS](https://git-lfs.com) 存放，而且**默认不下载**：仓库根目录的 `.lfsconfig` 排除了它，免得每次 clone 都消耗 LFS 流量。

需要时再下载：

```sh
git lfs install
git lfs pull --include="assets-src/**" --exclude=""
```

GitHub 免费的 LFS 空间只有 1 GB，所以仓库里只放了**地球**的全套原始数据（约 920 MB）：

| 文件 | 内容 | 来源 |
|---|---|---|
| `raw/sss/8k_earth_daymap.jpg`、`8k_earth_clouds.jpg`、`8k_earth_nightmap.jpg` | 地表颜色、云图、夜间灯光（8k） | Solar System Scope, CC BY 4.0 |
| `raw/nasa/BlackMarble_2016_3km.jpg` | 夜间灯光 | NASA Earth Observatory，公有领域 |
| `raw/nasa/PIA11707_orig.jpg` | NASA 原图 | NASA，公有领域 |
| `raw/etopo/etopo2022_60s_band*.nc` | 全球地形与海底高程（1 弧分，21600×10800） | NOAA ETOPO 2022，公有领域 |
| `previews/` | 处理过程中的对比预览图 | 由上述素材生成 |

其余原始素材**没有放进仓库**，`public/textures/` 里已经有它们处理好的版本，游戏照常使用。想重新生成的话，从官方地址下载到对应目录就行。每个文件的确切地址、署名和改动都在 [`public/textures/CREDITS.md`](public/textures/CREDITS.md) 里：

| 目录 | 内容 | 来源 |
|---|---|---|
| `raw/sss/` 其他文件 | 火星、水星、金星、木星、土星（含土星环）、天王星、海王星的贴图 | <https://www.solarsystemscope.com/textures/> |
| `raw/svs/` | 月球颜色与 LOLA 高程，以及 Milky Way 巡天图（EXR） | NASA SVS 4720 和 4851 |
| `raw/pds/` | 火星 MOLA 高程 | NASA PDS Geosciences |
| `raw/usgs/` | 木卫一到木卫四、土卫二、土卫六、海卫一、冥王星的全球拼图（约 1.3 GB） | USGS Astrogeology |
| `raw/galaxies/` | 星系照片 | ESA/Hubble、ESO，CC BY 4.0 |

星系、星云、星空本身都是程序生成的，不依赖这些照片；照片只用于对比，以及设置里可选的 "Milky Way photo" 显示。下载好之后运行 `scripts/textures/build.sh` 重新生成 `public/textures/`。这一步需要一个装了 numpy 和 Pillow 的 Python 虚拟环境 `.texvenv`：

```sh
python3 -m venv .texvenv && .texvenv/bin/pip install numpy pillow imagecodecs netCDF4
```

## 测试

```sh
npx tsc --noEmit
npm run build
node scripts/uitest.mjs          # 界面与操作的端到端检查，需要开着 dev 服务器
node scripts/gmotion.mjs         # 飞行时星系画面的流畅度（每帧运动、滞后、闪烁）
```

截图工具：`node scripts/gshot.mjs <名字> "<js>" [等待毫秒]`，结果在 `shots/`。这些工具用的是本机 Chrome（puppeteer-core），路径在脚本里。

## 素材与许可

贴图全部来自公有领域或 CC BY 4.0 来源，包括 NASA、USGS、NOAA、NASA SVS、Solar System Scope、ESA/Hubble 和 ESO。每个文件的来源、署名和改动见 [`public/textures/CREDITS.md`](public/textures/CREDITS.md)，游戏内按 F1 也能看到。没有使用 SpaceEngine 的任何素材。
