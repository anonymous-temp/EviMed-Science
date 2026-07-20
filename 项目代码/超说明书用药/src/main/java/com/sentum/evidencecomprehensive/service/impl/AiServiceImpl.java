package com.sentum.evidencecomprehensive.service.impl;

import com.sentum.evidencecomprehensive.service.AiService;
import com.sentum.evidencecomprehensive.utils.operateyl.RetryUtils;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/8/18
 */
@Service
public class AiServiceImpl implements AiService {
    
    private static final Logger LOG = LoggerFactory.getLogger(AiServiceImpl.class);
    
    @Override
    public Map<String, Object> trans(Map<String, Object> params) {
        if (params == null || params.isEmpty()) {
            return new HashMap<>();
        }

        Map<String, Object> result = new HashMap<>();
        for (Map.Entry<String, Object> entry : params.entrySet()) {
            LocalDateTime startTime = LocalDateTime.now();

            String key = entry.getKey();
            String value = entry.getValue().toString();

            String transResult = "";
            if (StringUtils.equalsAny(key, "title", "summary")) {
                transResult = RetryUtils.executeTransWithRetry(value, "zh", "中英互译");
//                transResult = AIRequestUtils.modelStudio(value, Constants.QWEN_MT_PLUS);
            }
            result.put(key, transResult);
        }
        return result;

//        // 构建包含所有字段的翻译prompt
//        StringBuilder fieldsBuilder = new StringBuilder();
//        fieldsBuilder.append("{\n");
//        boolean first = true;
//        for (Map.Entry<String, Object> entry : params.entrySet()) {
//            if (!first) {
//                fieldsBuilder.append(",\n");
//            }
//            fieldsBuilder.append("  \"").append(entry.getKey()).append("\": \"")
//                    .append(String.valueOf(entry.getValue())).append("\"");
//            first = false;
//        }
//        fieldsBuilder.append("\n}");
//
//        String batchTranslatePrompt = "请作为专业翻译专家，对输入数据所有字段值进行翻译处理：\n\n"
//                + "翻译规则：\n"
//                + "1. 语言识别与转换：\n"
//                + "   - 如果字段值是中文 → 翻译成英文\n"
//                + "   - 如果字段值是英文 → 翻译成中文\n"
//                + "   - 如果字段值是其他语言 → 翻译成中文\n"
//                + "2. 翻译质量要求：\n"
//                + "   - 保持原文准确含义和语境\n"
//                + "   - 专业术语使用标准翻译\n"
//                + "   - 保持自然流畅的表达\n"
//                + "   - 尊重文化差异和表达习惯\n"
//                + "3. 特殊处理规则：\n"
//                + "   - 空值或null保持原样\n"
//                + "   - 纯数字保持不变\n"
//                + "   - 专有名词保持翻译一致性\n"
//                + "   - 技术术语使用行业标准翻译\n"
//                + "   - 保持原有格式和结构\n\n"
//                + "输出要求：\n"
//                + "1. 保持JSON格式输出\n"
//                + "2. 保持所有原始key不变\n"
//                + "3. 只翻译value部分\n"
//                + "4. 返回完整的JSON对象\n"
//                + "5. 不要包含任何解释说明文字\n\n"
//                + "示例：\n"
//                + "输入：{\"name\": \"张三\", \"description\": \"软件工程师\"}\n"
//                + "输出：{\"name\": \"Zhang San\", \"description\": \"Software Engineer\"}\n\n"
//                + "输入数据：\n"
//                + fieldsBuilder.toString();
//
//        LocalDateTime startTime = LocalDateTime.now();
//
//        int retryCount = 0;
//        int maxRetryCount = 6;
//        while (retryCount < maxRetryCount) {
//            try {
//                String searchDrugEachResult = AIRequestUtils.modelStudio(batchTranslatePrompt, Constants.QWEN_MT_PLUS);
//                String splitDisease = "";
//                if (StringUtils.isNotBlank(searchDrugEachResult)) {
//                    int start = searchDrugEachResult.indexOf('{');
//                    int end = searchDrugEachResult.lastIndexOf('}');
//                    Gson gson = new Gson();
//                    Type jsonObject = new TypeToken<Map<String, Object>>(){}.getType();
//                    Map<String, Object> aiResult = gson.fromJson(searchDrugEachResult.substring(start, end + 1), jsonObject);
//                    LOG.info("翻译发费时间{}", LocalDateTime.now().getSecond() - startTime.getSecond());
//                    return aiResult;
//                }
//            } catch (Exception e) {
//                LOG.error("去除修饰词发生错误{}", e.getMessage(), e);
//            }
//            retryCount++;
//        }
//        return Collections.emptyMap();
    }
}
