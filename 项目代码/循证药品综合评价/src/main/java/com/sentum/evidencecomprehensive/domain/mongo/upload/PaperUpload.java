package com.sentum.evidencecomprehensive.domain.mongo.upload;

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
    /**
     * id
     */
    @Id
    private String id;

    /**
     * 文献id
     */
    private String paperId;

    /**
     * 用户id
     */
    private Long userId;

    // #####################  以下是上传 pdf 到 252 服务器 上 ##################
    /**
     * 上传是否成功
     */
    private boolean success;

    /**
     * 用户上传pdf文件存储路径  绝对路径  包含文件名称
     */
    private String filePath;

    /**
     * 用户上传文件的当前目录名称  不包含文件名称
     */
    private String path;

    /**
     * 用户上传文件存储地址  ip 可访问的路径
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
    
    private String paperType;
}