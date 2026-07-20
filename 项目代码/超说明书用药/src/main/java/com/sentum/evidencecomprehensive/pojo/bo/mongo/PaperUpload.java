package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 用户上传文献pdf实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_paper_upload")
public class PaperUpload {
    @Id
    private String id;
    private String paperId;
    private Long userId;
    private String source;

    // #####################  以下是上传 pdf 到 252 服务器 上 ##################
    /**
     * 上传是否成功
     */
    private boolean success;

    /**
     * 上传 pdf 绝对路径 包含文件名称
     */
    private String filePath;

    /**
     * 上传 pdf 绝对路径 不包含文件名称
     */
    private String path;

    /**
     * 上传 pdf ip 可访问的路径
     */
    private String fileUrl;

    /**
     * 上传的时间戳
     */
    private Long timeStamp;



    // ##################### 以下是上传到 pdf 解析四角坐标服务器 ##################

    /**
     * 用户上传pdf文件存储绝对路径(算法服务器地址)
     */
    private String filePath_alg;
}
