import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { organizations, events } from "../../db/schema";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(projectRoot, ".local", "d1.sqlite");

if (databasePath !== ":memory:") {
  mkdirSync(dirname(databasePath), { recursive: true });
}

const client = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });
const db = drizzle(client);

const organizationSeed = [
  {
    entityId: "org-quantum-systems-lab",
    slug: "quantum-systems-lab",
    name: "量子系统实验室",
    description:
      "专注超导量子比特、量子纠错与量子测量工程的研究机构，面向金融、材料和密码学场景提供可验证的量子计算原型。",
    entityType: "研究机构",
    isCoreTracking: true,
    region: "华东",
    country: "中国",
    founded: "2018",
    analysisType: "量子计算与产业化",
    relatedTypes: "量子计算,超导量子比特,科研机构",
    mentionCount: 18,
    credibilityScore: 92,
    source: "官方审计",
    sourceCount: 6,
    context:
      "该实验室承担国家量子信息专项的工程化课题，在上海建设超导量子计算测试平台，并与高校及金融机构开展联合验证。公开材料显示其研发重点从基础器件逐步转向容错算法和行业试点。全文检索关键词：量子 系统 实验室 量子计算 超导 量子纠错。",
    sourceLocation: "上海市浦东新区",
    sourceDocument: "2026 年量子科技机构官方审计报告",
    originalName: "Quantum Systems Laboratory",
    locationBasis: "官网、工商登记与审计报告交叉核验",
    locationConfidence: "高",
    summary:
      "量子系统实验室是中国东部活跃的量子计算研发机构，核心能力覆盖超导量子芯片、量子纠错和应用验证。可信度 92/100，主要依据为官方审计和项目验收材料。",
    websiteUrl: "https://example.org/quantum-systems-lab",
  },
  {
    entityId: "org-deepblue-ai-institute",
    slug: "deepblue-ai-institute",
    name: "深蓝人工智能研究院",
    description:
      "研究大模型推理、工业视觉和可信人工智能的应用型研究院，为制造业提供模型评测、数据治理与部署服务。",
    entityType: "人工智能研究院",
    isCoreTracking: true,
    region: "华南",
    country: "中国",
    founded: "2020",
    analysisType: "人工智能与产业应用",
    relatedTypes: "大模型,工业视觉,可信 AI",
    mentionCount: 24,
    credibilityScore: 88,
    source: "行业报告",
    sourceCount: 9,
    context:
      "研究院与汽车、电子制造和港口运营商建立联合实验室，公开发布中文大模型评测基准。其商业化进展主要来自企业订阅和模型安全审计，仍需持续关注数据合规披露。全文检索关键词：深蓝 人工智能 研究院 大模型 工业视觉 可信 AI。",
    sourceLocation: "深圳市南山区",
    sourceDocument: "2026 中国企业级人工智能行业报告",
    originalName: "DeepBlue Institute of Artificial Intelligence",
    locationBasis: "行业报告、研究院公告与合作方披露",
    locationConfidence: "高",
    summary:
      "深蓝人工智能研究院聚焦大模型推理、工业视觉和 AI 安全，已形成评测基准与企业部署能力。可信度 88/100，来源以独立行业报告和合作方披露为主。",
    websiteUrl: "https://example.org/deepblue-ai-institute",
  },
  {
    entityId: "org-galaxy-biomedical-center",
    slug: "galaxy-biomedical-center",
    name: "星河生物医药创新中心",
    description:
      "围绕肿瘤免疫、罕见病诊断和生物信息学开展转化医学研究，连接早期药物发现、临床试验与产业合作。",
    entityType: "生物医药研究机构",
    isCoreTracking: false,
    region: "华北",
    country: "中国",
    founded: "2016",
    analysisType: "转化医学与药物研发",
    relatedTypes: "肿瘤免疫,罕见病,临床试验",
    mentionCount: 15,
    credibilityScore: 85,
    source: "临床注册与药监公告",
    sourceCount: 7,
    context:
      "创新中心与三甲医院共建样本库和临床研究网络，重点项目覆盖免疫治疗伴随诊断。公开注册信息能够追踪项目阶段，但部分合作经费和专利许可细节尚未完全披露。全文检索关键词：星河 生物医药 创新中心 肿瘤免疫 罕见病 临床试验。",
    sourceLocation: "北京市海淀区",
    sourceDocument: "国家药监公开注册信息与 2025 年临床研究年报",
    originalName: "Galaxy Biomedical Innovation Center",
    locationBasis: "临床试验注册、药监公告与机构年报",
    locationConfidence: "高",
    summary:
      "星河生物医药创新中心面向肿瘤免疫和罕见病诊断推进转化医学，拥有稳定的医院协作网络。可信度 85/100，证据主要来自临床注册和药监公开公告。",
    websiteUrl: "https://example.org/galaxy-biomedical-center",
  },
  {
    entityId: "org-polaris-advanced-materials",
    slug: "polaris-advanced-materials",
    name: "北辰先进材料研究院",
    description:
      "研发固态电池材料、低碳复合材料与高温超导涂层，面向新能源装备和航空航天客户提供中试验证。",
    entityType: "先进材料研究院",
    isCoreTracking: false,
    region: "东北",
    country: "中国",
    founded: "2014",
    analysisType: "先进材料与能源技术",
    relatedTypes: "固态电池,复合材料,中试平台",
    mentionCount: 12,
    credibilityScore: 81,
    source: "学术论文与专利",
    sourceCount: 11,
    context:
      "研究院拥有材料表征和小规模中试线，论文与专利集中在固态电解质和耐高温涂层。产业合作处于放大验证阶段，量产订单及成本数据仍需要后续公开来源佐证。全文检索关键词：北辰 先进 材料 研究院 固态电池 复合材料 中试。",
    sourceLocation: "沈阳市浑南区",
    sourceDocument: "先进材料论文、专利族与中试项目公告汇编",
    originalName: "Polaris Institute for Advanced Materials",
    locationBasis: "论文作者单位、专利申请人和项目公告",
    locationConfidence: "中高",
    summary:
      "北辰先进材料研究院聚焦固态电池与低碳复合材料，具备从论文专利到中试验证的研发链条。可信度 81/100，当前证据以学术论文和专利为主。",
    websiteUrl: "https://example.org/polaris-advanced-materials",
  },
  {
    entityId: "org-horizon-clean-energy",
    slug: "horizon-clean-energy",
    name: "远景清洁能源技术集团",
    description:
      "提供风电预测、储能调度和绿氢系统集成服务，建设面向园区和公用事业客户的清洁能源数字化平台。",
    entityType: "清洁能源企业",
    isCoreTracking: true,
    region: "西北",
    country: "中国",
    founded: "2012",
    analysisType: "清洁能源与电力系统",
    relatedTypes: "风电,储能,绿氢",
    mentionCount: 21,
    credibilityScore: 79,
    source: "年报与项目公告",
    sourceCount: 8,
    context:
      "集团在内蒙古和甘肃运营风储一体化示范项目，数字平台覆盖功率预测和电力交易辅助决策。项目规模和并网进度可由年报核对，绿氢业务的盈利能力仍处于观察期。全文检索关键词：远景 清洁 能源 技术 集团 风电 储能 绿氢。",
    sourceLocation: "内蒙古自治区鄂尔多斯市",
    sourceDocument: "2025 年集团年报与风储一体化项目公告",
    originalName: "Horizon Clean Energy Technology Group",
    locationBasis: "年报、交易所公告与地方能源项目批复",
    locationConfidence: "高",
    summary:
      "远景清洁能源技术集团布局风电预测、储能调度和绿氢系统集成，拥有西北地区示范项目。可信度 79/100，来源为年报与项目公告，部分新业务仍需跟踪验证。",
    websiteUrl: "https://example.org/horizon-clean-energy",
  },
] as const;

const eventSeed = [
  {
    id: "evt-quantum-2024-platform",
    organizationId: "org-quantum-systems-lab",
    eventDate: "2024-06-18",
    eventType: "平台建设",
    title: "完成超导量子计算测试平台一期",
    summary: "实验室公布 72 比特测试平台并开放联合验证。影响：提升硬件研发的可复现性，为后续量子纠错实验和产业合作提供基础。",
    sourceUrl: "https://example.org/news/quantum-platform",
    sourceName: "量子系统实验室公告",
  },
  {
    id: "evt-quantum-2025-audit",
    organizationId: "org-quantum-systems-lab",
    eventDate: "2025-11-04",
    eventType: "审计与合作",
    title: "通过量子信息专项年度官方审计",
    summary: "专项审计确认关键设备采购和项目里程碑达到要求。影响：机构可信度上升，并获得下一阶段容错算法联合攻关资格。",
    sourceUrl: "https://example.org/news/quantum-audit",
    sourceName: "量子信息专项审计摘要",
  },
  {
    id: "evt-deepblue-2024-benchmark",
    organizationId: "org-deepblue-ai-institute",
    eventDate: "2024-03-12",
    eventType: "研究发布",
    title: "发布企业级中文大模型评测基准",
    summary: "研究院发布覆盖制造、客服和代码任务的公开评测集。影响：推动行业采用统一指标，也提高了其在企业 AI 采购中的可见度。",
    sourceUrl: "https://example.org/news/deepblue-benchmark",
    sourceName: "深蓝人工智能研究院",
  },
  {
    id: "evt-deepblue-2026-factory",
    organizationId: "org-deepblue-ai-institute",
    eventDate: "2026-02-20",
    eventType: "产业合作",
    title: "与华南汽车制造商共建工业视觉联合实验室",
    summary: "双方将部署缺陷检测和生产排程模型，并进行第三方安全评测。影响：验证模型从实验环境向工厂生产线迁移的商业化能力。",
    sourceUrl: "https://example.org/news/deepblue-factory-lab",
    sourceName: "合作方项目公告",
  },
  {
    id: "evt-galaxy-2023-registry",
    organizationId: "org-galaxy-biomedical-center",
    eventDate: "2023-09-07",
    eventType: "临床注册",
    title: "肿瘤免疫伴随诊断项目完成临床注册",
    summary: "项目进入多中心临床研究，注册信息披露受试者规模和主要终点。影响：为后续药物伴随诊断合作提供合规的临床证据路径。",
    sourceUrl: "https://example.org/news/galaxy-trial",
    sourceName: "临床试验注册平台",
  },
  {
    id: "evt-galaxy-2025-diagnostic",
    organizationId: "org-galaxy-biomedical-center",
    eventDate: "2025-08-29",
    eventType: "阶段性成果",
    title: "罕见病诊断试剂获得阶段性审评反馈",
    summary: "药监沟通会议确认补充验证方案和样本覆盖要求。影响：项目仍在推进，但上市时间和商业化规模需要等待后续审评结论。",
    sourceUrl: "https://example.org/news/galaxy-review",
    sourceName: "药监公开沟通摘要",
  },
  {
    id: "evt-polaris-2024-patent",
    organizationId: "org-polaris-advanced-materials",
    eventDate: "2024-01-25",
    eventType: "专利与研发",
    title: "固态电解质材料专利族进入国际阶段",
    summary: "研究院公布多项固态电解质配方专利的国际申请进展。影响：技术保护范围扩大，但工艺良率和规模化成本仍需中试数据支持。",
    sourceUrl: "https://example.org/news/polaris-patent",
    sourceName: "专利公开信息",
  },
  {
    id: "evt-polaris-2026-pilot",
    organizationId: "org-polaris-advanced-materials",
    eventDate: "2026-04-16",
    eventType: "中试验证",
    title: "启动固态电池材料中试线验证",
    summary: "研究院与电池厂商开展连续批次测试，重点观察循环寿命和涂布一致性。影响：若验证达标，有望进入定点供应商评估；当前仍属于研发示范阶段。",
    sourceUrl: "https://example.org/news/polaris-pilot",
    sourceName: "中试项目公告",
  },
  {
    id: "evt-horizon-2024-wind-storage",
    organizationId: "org-horizon-clean-energy",
    eventDate: "2024-10-11",
    eventType: "示范项目",
    title: "内蒙古风储一体化示范项目并网投运",
    summary: "项目完成首期风机与储能系统并网，平台开始提供功率预测和调度服务。影响：形成可量化的运营数据，并增强集团在西北电力市场的项目经验。",
    sourceUrl: "https://example.org/news/horizon-wind-storage",
    sourceName: "地方能源项目公告",
  },
  {
    id: "evt-horizon-2026-hydrogen",
    organizationId: "org-horizon-clean-energy",
    eventDate: "2026-01-30",
    eventType: "战略投资",
    title: "公布绿氢系统集成合作计划",
    summary: "集团与园区客户签署绿氢示范项目合作备忘录，计划接入可再生能源和长时储能。影响：打开新的增长方向，但项目资本开支和盈利能力仍需后续公告验证。",
    sourceUrl: "https://example.org/news/horizon-hydrogen",
    sourceName: "集团年度项目公告",
  },
] as const;

try {
  for (const organization of organizationSeed) {
      await db.insert(organizations)
        .values(organization)
        .onConflictDoUpdate({
          target: organizations.slug,
          set: organization,
        })
        .run();
  }

  for (const event of eventSeed) {
      await db.insert(events)
        .values(event)
        .onConflictDoUpdate({
          target: events.id,
          set: event,
        })
        .run();
  }

  console.log("✅ 成功注入 5 个机构和 10 个事件");
} finally {
  client.close();
}
