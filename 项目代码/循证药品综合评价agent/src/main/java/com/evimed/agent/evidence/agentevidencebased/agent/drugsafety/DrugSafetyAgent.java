package com.evimed.agent.evidence.agentevidencebased.agent.drugsafety;

import com.evimed.agent.evidence.agentevidencebased.agent.BaseAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.service.AgentTaskManager;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 药品安全性分析 Agent（FAERS ADR 信号挖掘）
 *
 * 轻量编排 Agent：不复用 Plan-Execute 循环，而是将问题归一化为药品名后，
 * 委托给下游 Python 药理安全 agent（HTTP 短轮询）执行 FAERS 信号分析，
 * 最终把下游生成的 Markdown 报告分段流式推给前端。
 *
 * 下游契约（固定，见需求文档）：
 *   POST {agentUrl}/api/v1/adr/analyze
 *        body {"drug":"<药品名>","reactions":[],"language":"zh"} → 200 {"jobId":"..."}
 *   GET  {agentUrl}/api/v1/adr/jobs/{jobId}
 *        → {"status":"running|succeeded|failed","progress":0-100,"error":null,"result":{...}}
 *   GET  {agentUrl}/api/v1/adr/jobs/{jobId}/report → text/markdown 中文报告
 *
 * execute() 阻塞执行，由 per-session 单线程执行器驱动。
 */
@Slf4j
public class DrugSafetyAgent extends BaseAgent {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 单次 HTTP 请求超时 */
    private static final Duration HTTP_REQUEST_TIMEOUT = Duration.ofSeconds(30);
    /** 下游 job 轮询间隔 */
    private static final Duration POLL_INTERVAL = Duration.ofSeconds(3);
    /** 下游 job 总等待超时 */
    private static final Duration JOB_TIMEOUT = Duration.ofMinutes(10);
    /** 报告分段流式推送的单段长度（字符） */
    private static final int REPORT_CHUNK_SIZE = 200;
    /** 报告分段推送间隔（模拟流式，避免一次性刷屏） */
    private static final long REPORT_CHUNK_DELAY_MS = 50;

    private static final List<String> STAGE_TITLES = List.of(
            "药品名称归一化", "ADR 信号分析", "安全性报告生成");

    private final ChatClient chatClient;
    private final HttpClient httpClient;
    private final String agentUrl;

    public DrugSafetyAgent(ChatModel chatModel, String agentUrl) {
        super("drug-safety-agent", chatModel, "drug-safety");
        this.chatClient = ChatClient.builder(chatModel).build();
        // 去掉末尾斜杠，避免拼接出双斜杠路径
        this.agentUrl = (agentUrl != null && agentUrl.endsWith("/"))
                ? agentUrl.substring(0, agentUrl.length() - 1)
                : agentUrl;
        this.httpClient = HttpClient.newBuilder()
                // uvicorn(h11) rejects the h2c upgrade that the default HTTP_2
                // version attempts, mangling the request body -> force HTTP/1.1
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    // ===== 入口：阻塞执行 =====

    @Override
    public void execute(String sessionId, String question, AgentSink sink) {
        if (isTaskRunning(sessionId)) {
            sink.error("该会话正在执行中，请稍后再试");
            return;
        }

        initTimers();
        clearUsedTools();

        AtomicBoolean stopped = new AtomicBoolean(false);
        StringBuilder answerBuffer = new StringBuilder();

        AgentTaskManager.TaskInfo taskInfo = registerTask(sessionId, () -> {
            if (stopped.compareAndSet(false, true)) {
                sink.error("您已停止该任务");
            }
        });
        if (taskInfo == null) {
            sink.error("该会话正在执行中，请稍后再试");
            return;
        }

        saveQuestion(sessionId, question);

        try {
            // 阶段一：药品名称归一化（LLM 提取，失败回退原文）
            sink.status(STAGE_TITLES, List.of("doing", "todo", "todo"));
            String drug = extractDrugName(question);
            sink.rawMessage("🔍 待分析药品：" + drug + "\n");

            // 阶段二：提交并轮询下游 ADR 分析任务
            sink.status(STAGE_TITLES, List.of("done", "doing", "todo"));
            String jobId = submitAnalyzeJob(drug);
            log.info("ADR 分析任务已提交: sessionId={}, drug={}, jobId={}", sessionId, drug, jobId);
            sink.rawMessage("⏳ 已提交 ADR 信号分析任务（jobId=" + jobId + "），正在分析...\n");
            pollJobUntilDone(jobId, sink, stopped);

            // 阶段三：拉取并流式推送 Markdown 报告
            sink.status(STAGE_TITLES, List.of("done", "done", "doing"));
            String report = fetchReport(jobId);
            streamReport(report, sink, stopped);
            answerBuffer.append(report);

            sink.status(STAGE_TITLES, List.of("done", "done", "done"));
            sink.complete();
            sink.finish("", "药品安全性分析报告-" + drug + ".md");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            if (!stopped.get()) {
                sink.error("任务被中断");
            }
        } catch (DrugSafetyException e) {
            // 业务错误（下游失败、超时、契约不符）：消息已面向用户，直接透传文案
            log.warn("药品安全性分析失败: sessionId={}, err={}", sessionId, e.getMessage());
            sink.error(e.getMessage());
        } catch (Exception e) {
            // 未预期错误：记录完整堆栈，对用户只给概括信息，不透传堆栈
            log.error("药品安全性分析异常: sessionId={}", sessionId, e);
            sink.error("药品安全性分析失败: " + (e.getMessage() != null ? e.getMessage() : "未知错误"));
        } finally {
            if (answerBuffer.length() > 0) {
                saveAnswer(answerBuffer.toString(), "");
            }
            removeTask(sessionId);
        }
    }

    // ===== 药品名称提取 =====

    /**
     * 用极短 prompt 让 LLM 从问题中提取药品通用名。
     * LLM 调用失败、结果为空或明显异常（超长）时回退为原始问题。
     */
    private String extractDrugName(String question) {
        String fallback = question.trim();
        try {
            String prompt = """
                    从以下用户问题中提取需要进行不良反应（ADR）分析的药品通用名。
                    要求：
                    1. 只输出药品的英文通用名（generic name,小写）,不要输出任何解释、标点或其他内容。
                    2. 如果问题中的药品名是中文或其他语言,请翻译成对应的英文通用名(例如:阿托伐他汀→atorvastatin、二甲双胍→metformin)。
                    3. 如果有多个药品,只输出最主要的一个。
                    4. 如果问题中没有明确的药品名称,原样输出用户问题。

                    用户问题：
                    %s
                    """.formatted(question);

            String result = chatClient.prompt().user(prompt).call().content();
            if (result == null || result.isBlank()) {
                log.warn("药品名提取结果为空，回退原文");
                return fallback;
            }
            String drug = result.trim();
            // 防御：提取结果不应超过合理药名长度，否则视为提取失败
            if (drug.length() > 50) {
                log.warn("药品名提取结果过长（{}字符），回退原文: {}", drug.length(), drug.substring(0, 50));
                return fallback;
            }
            return drug;
        } catch (Exception e) {
            log.warn("LLM 药品名提取失败，回退原文: {}", e.getMessage());
            return fallback;
        }
    }

    // ===== 下游 HTTP 交互 =====

    /**
     * 提交 ADR 分析任务，返回 jobId。
     */
    private String submitAnalyzeJob(String drug) throws Exception {
        String body = MAPPER.writeValueAsString(Map.of(
                "drug", drug,
                "reactions", List.of(),
                "language", "zh"));

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(agentUrl + "/api/v1/adr/analyze"))
                .timeout(HTTP_REQUEST_TIMEOUT)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() / 100 != 2) {
            // include the downstream detail and the outgoing payload for diagnosis (no secrets involved)
            log.warn("analyze 提交被拒: status={}, downstream={}, requestBody={}",
                    response.statusCode(), response.body(), body);
            throw new DrugSafetyException("ADR 分析任务提交失败（HTTP " + response.statusCode() + "）");
        }

        JsonNode root = readJson(response.body(), "分析任务响应");
        JsonNode jobId = root.get("jobId");
        if (jobId == null || jobId.isNull() || jobId.asText().isBlank()) {
            throw new DrugSafetyException("ADR 分析任务响应缺少 jobId，下游契约不符");
        }
        return jobId.asText();
    }

    /**
     * 短轮询下游任务直到 succeeded / failed / 超时。
     * 进度变化时向前端推送进度消息。
     */
    private void pollJobUntilDone(String jobId, AgentSink sink, AtomicBoolean stopped)
            throws Exception {
        long deadline = System.currentTimeMillis() + JOB_TIMEOUT.toMillis();
        int lastProgress = -1;

        while (true) {
            if (stopped.get() || Thread.currentThread().isInterrupted()) {
                throw new InterruptedException("任务已被用户停止");
            }

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(agentUrl + "/api/v1/adr/jobs/" + jobId))
                    .timeout(HTTP_REQUEST_TIMEOUT)
                    .GET()
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw new DrugSafetyException("查询 ADR 分析进度失败（HTTP " + response.statusCode() + "）");
            }

            JsonNode root = readJson(response.body(), "任务状态响应");
            String status = root.path("status").asText("");
            switch (status) {
                case "succeeded" -> {
                    sink.rawMessage("✅ 信号分析完成，正在生成报告...\n");
                    return;
                }
                case "failed" -> {
                    String error = root.path("error").asText(null);
                    throw new DrugSafetyException(
                            "下游 ADR 分析任务失败" + (error != null && !error.isBlank() ? ": " + error : ""));
                }
                default -> {
                    // running 或其他未知状态：继续等待，进度变化时推送一次
                    int progress = root.path("progress").asInt(0);
                    if (progress != lastProgress) {
                        lastProgress = progress;
                        sink.progress(progress, 100, "ADR 信号分析中");
                    }
                }
            }

            if (System.currentTimeMillis() >= deadline) {
                throw new DrugSafetyException("ADR 分析超时（超过 10 分钟未完成），请稍后重试");
            }
            Thread.sleep(POLL_INTERVAL.toMillis());
        }
    }

    /**
     * 拉取完整 Markdown 报告。
     */
    private String fetchReport(String jobId) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(agentUrl + "/api/v1/adr/jobs/" + jobId + "/report"))
                .timeout(HTTP_REQUEST_TIMEOUT)
                .header("Accept", "text/markdown, text/plain, */*")
                .GET()
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new DrugSafetyException("获取 ADR 分析报告失败（HTTP " + response.statusCode() + "）");
        }
        String report = response.body();
        if (report == null || report.isBlank()) {
            throw new DrugSafetyException("下游返回的 ADR 分析报告为空");
        }
        return report;
    }

    // ===== 报告流式推送 =====

    /**
     * 将完整 Markdown 报告按固定长度分段流式推送，模拟打字机效果。
     */
    private void streamReport(String report, AgentSink sink, AtomicBoolean stopped)
            throws InterruptedException {
        sink.rawMessage("📝 正在推送安全性分析报告...\n\n");
        for (int offset = 0; offset < report.length(); offset += REPORT_CHUNK_SIZE) {
            if (stopped.get() || Thread.currentThread().isInterrupted()) {
                throw new InterruptedException("任务已被用户停止");
            }
            recordFirstResponse();
            int end = Math.min(offset + REPORT_CHUNK_SIZE, report.length());
            sink.streamAppend(report.substring(offset, end));
            Thread.sleep(REPORT_CHUNK_DELAY_MS);
        }
    }

    // ===== 工具方法 =====

    private JsonNode readJson(String body, String what) throws DrugSafetyException {
        try {
            return MAPPER.readTree(body);
        } catch (Exception e) {
            throw new DrugSafetyException("解析下游" + what + "失败（非 JSON 响应）");
        }
    }

    /**
     * 面向用户的业务错误：消息文案可直接展示给前端。
     */
    private static class DrugSafetyException extends Exception {
        DrugSafetyException(String message) {
            super(message);
        }
    }
}
