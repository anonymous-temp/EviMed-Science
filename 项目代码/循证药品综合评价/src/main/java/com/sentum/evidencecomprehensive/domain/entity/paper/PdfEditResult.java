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
@ApiModel(value = "PdfEditResult对象", description = "质量评价编辑之后的信息实体 高中低 是否部分是不适用数量等")
@TableName("pdf_edit_result")
@NoArgsConstructor
@AllArgsConstructor
public class PdfEditResult implements Serializable {

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
     * 文献 类型
     */
    private String paperType;

    /**
     *  课题 id
     */
    private String questionId;

    /**
     *  文献质量高低
     */
    private String qualityMeta;

    /**
     *  是
     */
    private int yesNum;

    /**
     *  部分是
     */
    private int partNum;

    /**
     *  否
     */
    private int noNum;

    /**
     *  不适用
     */
    private int notApplicableNum;

    /**
     *  其他类型
     */
    private int otherNum;
}
