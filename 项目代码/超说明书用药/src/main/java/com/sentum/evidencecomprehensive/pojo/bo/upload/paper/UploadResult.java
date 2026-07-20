package com.sentum.evidencecomprehensive.pojo.bo.upload.paper;

import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class UploadResult {
    private boolean mainSuccess;
    private boolean algSuccess;
}
