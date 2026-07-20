package com.sentum.evidencecomprehensive.event.bo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Description:
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class PictureAnalysisBo {

    /**
     * 文献 id
     */
    private String id;


    /**
     * 课题 id
     */
    private String questionId;

    /**
     * 用户 id
     */
    private Long userId;

    /**
     * 图片路径
     */
    private String filePath;

    /**
     * 图片存放的当前目录
     */
    private String path;

    /**
     * 解析的图片类型
     */
    private String type;


    // ################## 算法相关 ############

    /**
     * pdf 存放路径
     */
    private String pdfFilePath;

    /**
     * 文献语言类型
     */
    private String lang;

    /**
     *  文献类型 4 RCT
     */
    private String studyType;

    /**
     * 是否成功上传到算法服务器上 pdf
     */
    private Boolean algAnalysisSuccess;
}
