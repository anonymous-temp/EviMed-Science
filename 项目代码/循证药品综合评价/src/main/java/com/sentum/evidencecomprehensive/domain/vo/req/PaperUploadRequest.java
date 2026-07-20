package com.sentum.evidencecomprehensive.domain.vo.req;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.web.multipart.MultipartFile;

@Data
@ApiModel(value = "PaperUploadRequest", description = "文献上传pdf的dto类")
@NoArgsConstructor
@AllArgsConstructor
public class PaperUploadRequest {

    @ApiModelProperty("文献 id")
    private String id;

    @ApiModelProperty("课题 id")
    private String questionId;

    @ApiModelProperty("文献类型")
    private String type;

    @ApiModelProperty("上传的文献pdf")
    private MultipartFile file;
}
