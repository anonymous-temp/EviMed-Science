package com.sentum.evidencecomprehensive.domain.entity.paper;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import io.swagger.annotations.ApiModel;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

/**
 * <p>
 * 
 * </p>
 *
 */
@Data
@ApiModel(value = "PaperInfo对象", description = "文献的信息提取实体类")
@TableName("paper_info")
@NoArgsConstructor
@AllArgsConstructor
public class PaperInfo implements Serializable {
    private static final long serialVersionUID = 1L;

    /**
     * id
     */
    @TableId(value = "id", type = IdType.AUTO)
    private String id;

    /**
     * 文献 id
     */
    private String paperId;

    /**
     *  课题 id
     */
    private String questionId;

    /**
     *  标准 id
     */
    private String infoId;

    /**
     *  标题
     */
    private String title;

    /**
     *  标题内容
     */
    private String content;

    /**
     *  量表 pdfurl
     */
    private String pdfUrl;
}
