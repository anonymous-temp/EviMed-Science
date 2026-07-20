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
public class AlgAnalysisBo {

    /**
     * 文献 id
     */
    private String id;

    /**
     * 课题 id
     */
    private String questionId;

    /**
     * 用户id
     */
    private Long userId;

    /**
     * pdf 存放路径 算法服务器使用的 
     */
    private String pdfFilePath;

    /**
     * 文献语言类型
     */
    private String lang;

    /**
     *  文献类型 4 RCT
     */
    private String  studyType;
}
