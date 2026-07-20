package com.sentum.evidencecomprehensive.pojo.bo.upload.paper;

import lombok.Builder;
import lombok.Data;

import java.util.UUID;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/7/29
 */

@Data
@Builder
public class FileUploadInfo {
    private String fileName;
    private UUID fileNameUUID;
    private String remotePath;
    private String remoteFilePath;
    private String ipFilePath;
    private String algRemoteFilePath;
}
