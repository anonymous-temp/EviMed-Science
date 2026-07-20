package com.evimed.agent.evidence.agentevidencebased.infrastructure;

import com.aliyun.oss.OSS;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.config.AliyunOssConfig;
import com.aliyun.oss.model.ObjectMetadata;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * OSS 报告上传工具
 * 将 Markdown 格式报告内容上传到阿里云 OSS，返回 URL
 */
@Slf4j
@Component
@ConditionalOnBean(AliyunOssConfig.class)
public class OssReportUploader {

    @Autowired
    private OSS ossClient;

    @Autowired
    private AliyunOssConfig ossConfig;

    /**
     * 上传报告内容（Markdown 字符串）到 OSS
     *
     * @param userId   用户 ID（用于路径隔离，无法获取时传 0）
     * @param content  报告 Markdown 内容
     * @param fileName 文件名（如：XX治疗YY_循证报告.md）
     * @return 包含 url / fileName / fileSize 的 map；失败时返回空 map
     */
    public Map<String, String> uploadReportContent(long userId, String content, String fileName) {
        Map<String, String> result = new HashMap<>();
        long startTime = System.currentTimeMillis();

        try {
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            ByteArrayInputStream inputStream = new ByteArrayInputStream(bytes);

            double sizeInKB = BigDecimal.valueOf(bytes.length)
                    .divide(BigDecimal.valueOf(1024), 2, RoundingMode.HALF_UP)
                    .doubleValue();

            String uuid = UUID.randomUUID().toString().replace("-", "");
            String suffix = (fileName != null && fileName.contains("."))
                    ? fileName.substring(fileName.lastIndexOf("."))
                    : ".md";
            String filePath = ossConfig.getFileHost() + "/" + userId + "/" + uuid + suffix;

            ObjectMetadata metadata = new ObjectMetadata();
            metadata.setContentLength(bytes.length);
            metadata.setContentType("text/markdown; charset=utf-8");

            ossClient.putObject(ossConfig.getBucketName(), filePath, inputStream, metadata);
            inputStream.close();

            String url = ossConfig.getFileUrl() + "/" + filePath;
            result.put("url", url);
            result.put("fileName", fileName != null ? fileName : (uuid + suffix));
            result.put("fileSize", String.format("%.1fKB", sizeInKB));

            log.info("报告已上传 OSS: userId={}, file={}, url={}, 耗时={}ms",
                    userId, fileName, url, System.currentTimeMillis() - startTime);
        } catch (Exception e) {
            log.error("报告上传 OSS 失败: {}", e.getMessage(), e);
        }
        return result;
    }
}
